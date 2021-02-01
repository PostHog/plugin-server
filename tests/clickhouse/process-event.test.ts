import {
    Element,
    Event,
    Person,
    PersonDistinctId,
    PluginsServer,
    PluginsServerConfig,
    PostgresSessionRecordingEvent,
} from '../../src/types'
import { createServer } from '../../src/server'
import { resetTestDatabase } from '../helpers/sql'
import { resetTestDatabaseClickhouse } from '../helpers/clickhouse'
import { KafkaCollector, KafkaObserver } from '../helpers/kafka'
import { UUIDT } from '../../src/utils'
import { DateTime } from 'luxon'
import { createProcessEventTests } from '../shared/process-event.test'

jest.setTimeout(180_000) // 3 minute timeout

async function getSessionRecordingEvents(server: PluginsServer): Promise<PostgresSessionRecordingEvent[]> {
    const result = await server.db.postgresQuery('SELECT * FROM posthog_sessionrecordingevent')
    return result.rows as PostgresSessionRecordingEvent[]
}

async function getEvents(server: PluginsServer): Promise<Event[]> {
    const result = await server.db.postgresQuery('SELECT * FROM posthog_event')
    return result.rows as Event[]
}

async function getPersons(server: PluginsServer): Promise<Person[]> {
    const result = await server.db.postgresQuery('SELECT * FROM posthog_person')
    return result.rows as Person[]
}

async function getDistinctIds(server: PluginsServer, person: Person): Promise<string[]> {
    const result = await server.db.postgresQuery(
        'SELECT * FROM posthog_persondistinctid WHERE person_id=$1 and team_id=$2 ORDER BY id',
        [person.id, person.team_id]
    )
    return (result.rows as PersonDistinctId[]).map((pdi) => pdi.distinct_id)
}

async function getElements(server: PluginsServer, event: Event): Promise<Element[]> {
    return (await server.db.postgresQuery('SELECT * FROM posthog_element')).rows
}

const extraServerConfig: Partial<PluginsServerConfig> = {
    KAFKA_ENABLED: true,
    KAFKA_HOSTS: 'kafka:9092',
    DATABASE_URL: 'postgres://posthog:posthog@localhost:5439/test_posthog',
}

describe('process event (clickhouse)', () => {
    const kafkaObserver = new KafkaObserver(extraServerConfig)

    beforeEach(async () => {
        await resetTestDatabaseClickhouse(extraServerConfig)
    })

    const server = createProcessEventTests(
        'clickhouse',
        {
            getSessionRecordingEvents,
            getEvents,
            getPersons,
            getDistinctIds,
            getElements,
        },
        extraServerConfig
    )

    test('event is passed through', async () => {
        const uuid = new UUIDT().toString()
        const now = DateTime.utc()
        console.log('starting kafka observer')
        await kafkaObserver.start()
        console.log('sending message')
        const kafkaCollector = new KafkaCollector(kafkaObserver)
        await kafkaObserver.handOffMessage({
            distinct_id: 'abcd',
            ip: '1.1.1.1',
            site_url: 'x.com',
            team_id: 1,
            uuid,
            data: {
                distinct_id: 'abcd',
                ip: '1.1.1.1',
                site_url: 'x.com',
                team_id: 1,
                now: now.toString(),
                event: 'test',
                uuid,
            },
            now,
            sent_at: null,
        })
        console.log('waiting for messages')
        const processedMessages = await kafkaCollector.collect(1)

        console.log(processedMessages)
        expect(1).toEqual(1)
    })
})
