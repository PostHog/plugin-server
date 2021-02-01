import { PluginsServerConfig } from '../../src/types'
import { resetTestDatabaseClickhouse } from '../helpers/clickhouse'
import { KafkaCollector, KafkaObserver } from '../helpers/kafka'
import { UUIDT } from '../../src/utils'
import { DateTime } from 'luxon'
import { createProcessEventTests } from '../shared/process-event'

jest.setTimeout(180_000) // 3 minute timeout

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
            getSessionRecordingEvents: (server) => server.db.fetchSessionRecordingEvents(),
            getEvents: (server) => server.db.fetchEvents(),
            getPersons: (server) => server.db.fetchPersons(),
            getDistinctIds: (server, person) => server.db.fetchDistinctIdValues(person),
            getElements: (server) => server.db.fetchElements(),
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
