import { defaultConfig } from '../../server'
import { makePiscina } from '../piscina'
import { PluginEvent } from 'posthog-plugins/src/types'
import { performance } from 'perf_hooks'

jest.setTimeout(300000) // 300 sec timeout

test('piscina', async () => {
    const piscina = makePiscina({ ...defaultConfig, WORKER_CONCURRENCY: 2 })
    const processEvent = (event: PluginEvent) => piscina.runTask({ task: 'processEvent', args: { event } })

    function processOneEvent(): Promise<PluginEvent> {
        const defaultEvent = {
            distinct_id: 'my_id',
            ip: '127.0.0.1',
            site_url: 'http://localhost',
            team_id: 3,
            now: new Date().toISOString(),
            event: 'default event',
            properties: { key: 'value' },
        }

        return processEvent(defaultEvent)
    }

    async function processCountEvents(count: number) {
        const startTime = performance.now()
        const promises = Array(count)
        for (let i = 0; i < count; i++) {
            promises[i] = processOneEvent()
        }
        // this will get heavy for tests > 10k events, should chunk them somehow...
        await Promise.all(promises)

        const ms = Math.round((performance.now() - startTime) * 1000) / 1000

        const log = {
            eventsPerSecond: 1000 / (ms / count),
            events: count,
            concurrency: piscina.threads.length,
            totalMs: ms,
            averageEventMs: ms / count,
        }

        console.log(JSON.stringify(log, null, 2))
    }

    console.log('100 event warmup!')
    await processCountEvents(100)

    console.log('--- START BENCHMARKING ---')
    for (let i = 0; i < 10; i++) {
        await processCountEvents(10000)
    }
})
