import { PluginsServerConfig } from '../../src/types'
import { resetTestDatabaseClickhouse } from '../helpers/clickhouse'
import { resetKafka } from '../helpers/kafka'
import { createProcessEventTests } from '../shared/process-event'

jest.setTimeout(180_000) // 3 minute timeout

const extraServerConfig: Partial<PluginsServerConfig> = {
    KAFKA_ENABLED: true,
    KAFKA_HOSTS: process.env.KAFKA_HOSTS || 'kafka:9092',
}

describe('process event (clickhouse)', () => {
    beforeAll(async () => {
        await resetKafka(extraServerConfig)
    })

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
})
