import { Database, LogLevel, PluginsServer, PluginsServerConfig, Team } from '../../src/types'
import { getFirstTeam, resetTestDatabase } from '../helpers/sql'
import { startPluginsServer } from '../../src/server'
import { makePiscina } from '../../src/worker/piscina'
import { createPosthog, DummyPostHog } from '../../src/extensions/posthog'
import { pluginConfig39 } from '../helpers/plugins'
import { UUIDT } from '../../src/utils'
import { resetTestDatabaseClickhouse } from '../helpers/clickhouse'
import { resetKafka } from '../helpers/kafka'
import { delayUntilEventIngested } from '../shared/process-event'
import { DateTime } from 'luxon'

jest.setTimeout(60000) // 60 sec timeout

const extraServerConfig: Partial<PluginsServerConfig> = {
    KAFKA_ENABLED: true,
    KAFKA_HOSTS: process.env.KAFKA_HOSTS || 'kafka:9092',
    WORKER_CONCURRENCY: 2,
    PLUGIN_SERVER_INGESTION: true,
    LOG_LEVEL: LogLevel.Log,
}

describe('postgres parity', () => {
    let server: PluginsServer
    let stopServer: () => Promise<void>
    let posthog: DummyPostHog
    let team: Team

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
        team = await getFirstTeam(server)
    })

    afterEach(async () => {
        await stopServer()
    })

    test('createPerson does the same in both databases', async () => {
        const person = server.db.createPerson(
            DateTime.utc(),
            { userProp: 'propValue' },
            team.id,
            null,
            true,
            new UUIDT().toString(),
            ['distinct1', 'distinct2']
        )
        await delayUntilEventIngested(() => server.db.fetchPersons(Database.ClickHouse))

        const clickHousePersons = await server.db.fetchPersons(Database.ClickHouse)
        const postgresPersons = await server.db.fetchPersons(Database.Postgres)

        expect(clickHousePersons.length).toEqual(postgresPersons.length)
    })

    // test('createPerson', async () => {})
    // test('updatePerson', async () => {})
    // test('deletePerson', async () => {})
    // test('addDistinctId', async () => {})
    // test('updateDistinctId', async () => {})
})
