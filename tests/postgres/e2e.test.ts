import { LogLevel } from '../../src/types'
import { resetTestDatabase } from '../helpers/sql'
import { startPluginsServer } from '../../src/server'
import { makePiscina } from '../../src/worker/piscina'
import { PluginsServer } from '../../src/types'
import { createPosthog, DummyPostHog } from '../../src/extensions/posthog'
import { pluginConfig39 } from '../helpers/plugins'
import { delay } from '../../src/utils'

jest.setTimeout(60000) // 60 sec timeout

describe('e2e postgres ingestion', () => {
    let server: PluginsServer
    let stopServer: () => Promise<void>
    let posthog: DummyPostHog

    beforeEach(async () => {
        await resetTestDatabase(`
            async function processEvent (event) {
                event.properties.processed = 'hell yes'
                return event
            }
        `)
        const startResponse = await startPluginsServer(
            {
                WORKER_CONCURRENCY: 2,
                PLUGINS_CELERY_QUEUE: 'test-plugins-celery-queue',
                CELERY_DEFAULT_QUEUE: 'test-celery-default-queue',
                PLUGIN_SERVER_INGESTION: true,
                LOG_LEVEL: LogLevel.Log,
                KAFKA_ENABLED: false,
            },
            makePiscina
        )
        server = startResponse.server
        stopServer = startResponse.stop

        await server.redis.del(server.PLUGINS_CELERY_QUEUE)
        await server.redis.del(server.CELERY_DEFAULT_QUEUE)

        posthog = createPosthog(server, pluginConfig39)
    })

    afterEach(async () => {
        await stopServer()
    })

    test('event captured, processed, ingested', async () => {
        expect((await server.db.fetchEvents()).length).toBe(0)
        posthog.capture('custom event', { name: 'haha' })
        await delay(2000)
        const events = await server.db.fetchEvents()
        expect(events.length).toBe(1)
        expect(events[0].properties.processed).toEqual('hell yes')
    })
})
