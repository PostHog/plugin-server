import { PluginEvent } from '@posthog/plugin-scaffold/src/types'
import { performance } from 'perf_hooks'
import { LogLevel, PluginsServer, SessionRecordingEvent, Team } from '../src/types'
import { getFirstTeam, resetTestDatabase } from '../tests/helpers/sql'
import { EventsProcessor } from '../src/ingestion/process-event'
import { DateTime } from 'luxon'
import { createServer } from '../src/server'
import { UUIDT } from '../src/utils'
import { IEvent } from '../src/idl/protos'

jest.mock('../src/sql')
jest.setTimeout(600000) // 600 sec timeout

describe('ingestion benchmarks', () => {
    let team: Team
    let server: PluginsServer
    let stopServer: () => Promise<void>
    let eventsProcessor: EventsProcessor
    let now = DateTime.utc()

    function processOneEvent(): Promise<IEvent | SessionRecordingEvent> {
        return eventsProcessor.processEvent(
            'my_id',
            '127.0.0.1',
            'http://localhost',
            ({
                event: 'default event',
                timestamp: now.toISO(),
                properties: { token: team.api_token },
            } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )
    }

    beforeEach(async () => {
        await resetTestDatabase(`
            function processEvent (event, meta) {
                event.properties["somewhere"] = "in a benchmark";
                return event
            }
        `)
        ;[server, stopServer] = await createServer({
            PLUGINS_CELERY_QUEUE: 'benchmark-plugins-celery-queue',
            CELERY_DEFAULT_QUEUE: 'benchmark-celery-default-queue',
            LOG_LEVEL: LogLevel.Log,
        })
        eventsProcessor = new EventsProcessor(server)
        team = await getFirstTeam(server)
        now = DateTime.utc()

        // warmup
        for (let i = 0; i < 5; i++) {
            await processOneEvent()
        }
    })

    afterEach(async () => {
        await stopServer?.()
    })

    test('basic sequential ingestion', async () => {
        const count = 3000
        const startTime = performance.now()
        for (let i = 0; i < count; i++) {
            await processOneEvent()
        }
        const timeMs = performance.now() - startTime
        const n = (n: number) => `${Math.round(n * 100) / 100}`
        console.log(`Ingested ${count} events in ${n(timeMs / 1000)}s (${n(timeMs / count)}ms per event)`)
    })

    test('basic parallel ingestion', async () => {
        const count = 3000
        const startTime = performance.now()
        const promises = []
        for (let i = 0; i < count; i++) {
            promises.push(processOneEvent())
        }
        await Promise.all(promises)
        const timeMs = performance.now() - startTime
        const n = (n: number) => `${Math.round(n * 100) / 100}`
        console.log(`Ingested ${count} events in ${n(timeMs / 1000)}s (${n(timeMs / count)}ms per event)`)
    })
})
