import { LogLevel, PluginsServerConfig } from '../../src/types'
import { resetTestDatabase } from '../helpers/sql'
import { startPluginsServer } from '../../src/server'
import { makePiscina } from '../../src/worker/piscina'
import { PluginsServer } from '../../src/types'
import { createPosthog, DummyPostHog } from '../../src/extensions/posthog'
import { pluginConfig39 } from '../helpers/plugins'
import { delay, UUIDT } from '../../src/utils'
import { resetTestDatabaseClickhouse } from '../helpers/clickhouse'
import { resetKafka } from '../helpers/kafka'

jest.setTimeout(60000) // 60 sec timeout

const extraServerConfig: Partial<PluginsServerConfig> = {
    KAFKA_ENABLED: true,
    KAFKA_HOSTS: 'kafka:9092',
    WORKER_CONCURRENCY: 2,
    PLUGIN_SERVER_INGESTION: true,
    LOG_LEVEL: LogLevel.Log,
}

describe('e2e clickhouse ingestion', () => {
    let server: PluginsServer
    let stopServer: () => Promise<void>
    let posthog: DummyPostHog

    beforeAll(async () => {
        await resetKafka(extraServerConfig)
    })

    beforeEach(async () => {
        await resetTestDatabase(`
            async function processEvent (event) {
                event.properties.processed = 'hell yes'
                event.properties.upperUuid = event.properties.uuid?.toUpperCase()
                return event
            }
        `)
        await resetTestDatabaseClickhouse(extraServerConfig)
        const startResponse = await startPluginsServer(extraServerConfig, makePiscina)
        server = startResponse.server
        stopServer = startResponse.stop
        posthog = createPosthog(server, pluginConfig39)
    })

    afterEach(async () => {
        await stopServer()
    })

    test('event captured, processed, ingested', async () => {
        expect((await server.db.fetchEvents()).length).toBe(0)
        const uuid = new UUIDT().toString()
        posthog.capture('custom event', { name: 'haha', uuid })
        await delay(10000)
        const events = await server.db.fetchEvents()
        expect(events.length).toBe(1)
        expect(events[0].properties.processed).toEqual('hell yes')
        expect(events[0].properties.upperUuid).toEqual(uuid.toUpperCase())
    })
})
