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

    test('createPerson', async () => {
        const uuid = new UUIDT().toString()
        const person = await server.db.createPerson(
            DateTime.utc(),
            { userProp: 'propValue' },
            team.id,
            null,
            true,
            uuid,
            ['distinct1', 'distinct2']
        )
        await delayUntilEventIngested(() => server.db.fetchPersons(Database.ClickHouse))

        const clickHousePersons = await server.db.fetchPersons(Database.ClickHouse)
        expect(clickHousePersons).toEqual([
            {
                id: uuid,
                created_at: expect.any(String), // '2021-02-04 00:18:26.472',
                team_id: team.id,
                properties: '{"userProp":"propValue"}',
                is_identified: 1,
                _timestamp: expect.any(String),
                _offset: expect.any(Number),
            },
        ])
        const clickHouseDistinctIds = await server.db.fetchDistinctIdValues(person, Database.ClickHouse)
        expect(clickHouseDistinctIds).toEqual(['distinct1', 'distinct2'])

        const postgresPersons = await server.db.fetchPersons(Database.Postgres)
        expect(postgresPersons).toEqual([
            {
                id: expect.any(Number),
                created_at: expect.any(String),
                properties: {
                    userProp: 'propValue',
                },
                team_id: 2,
                is_user_id: null,
                is_identified: true,
                uuid: uuid,
            },
        ])
        const postgresDistinctIds = await server.db.fetchDistinctIdValues(person, Database.Postgres)
        expect(postgresDistinctIds).toEqual(['distinct1', 'distinct2'])
    })

    test.skip('updatePerson', async () => {
        // TODO
    })

    test.skip('deletePerson', async () => {
        // TODO
    })

    test('addDistinctId', async () => {
        const uuid = new UUIDT().toString()
        const uuid2 = new UUIDT().toString()
        const person = await server.db.createPerson(
            DateTime.utc(),
            { userProp: 'propValue' },
            team.id,
            null,
            true,
            uuid,
            ['distinct1']
        )
        const anotherPerson = await server.db.createPerson(
            DateTime.utc(),
            { userProp: 'propValue' },
            team.id,
            null,
            true,
            uuid2,
            ['another_distinct_id']
        )
        await delayUntilEventIngested(() => server.db.fetchPersons(Database.ClickHouse))

        const [postgresPerson] = await server.db.fetchPersons(Database.Postgres)

        const clickHouseDistinctIds = await server.db.fetchDistinctIdValues(postgresPerson, Database.ClickHouse)
        const postgresDistinctIds = await server.db.fetchDistinctIdValues(postgresPerson, Database.Postgres)

        expect(clickHouseDistinctIds).toEqual(['distinct1'])
        expect(postgresDistinctIds).toEqual(['distinct1'])

        await server.db.addDistinctId(postgresPerson, 'anotherOne')

        await delayUntilEventIngested(() => server.db.fetchDistinctIdValues(postgresPerson, Database.ClickHouse), 2)

        const clickHouseDistinctIds2 = await server.db.fetchDistinctIdValues(postgresPerson, Database.ClickHouse)
        const postgresDistinctIds2 = await server.db.fetchDistinctIdValues(postgresPerson, Database.Postgres)

        expect(clickHouseDistinctIds2).toEqual(['distinct1', 'distinct2', 'anotherOne'])
        expect(postgresDistinctIds2).toEqual(['distinct1', 'distinct2', 'anotherOne'])
    })

    test.skip('updateDistinctId', async () => {
        // could be merged with the above one
    })
})
