import { DateTime } from 'luxon'

import { KAFKA_EVENTS_PLUGIN_INGESTION } from '../../src/config/kafka-topics'
import { Event, PluginsServerConfig } from '../../src/types'
import { resetTestDatabaseClickhouse } from '../helpers/clickhouse'
import { resetKafka } from '../helpers/kafka'
import { getFirstTeam, resetTestDatabase } from '../helpers/sql'
import { createPerson, createProcessEventTests } from '../shared/process-event'

jest.setTimeout(180_000) // 3 minute timeout

const extraServerConfig: Partial<PluginsServerConfig> = {
    KAFKA_ENABLED: true,
    KAFKA_HOSTS: process.env.KAFKA_HOSTS || 'kafka:9092',
    KAFKA_CONSUMPTION_TOPIC: KAFKA_EVENTS_PLUGIN_INGESTION,
}

describe('process event (clickhouse)', () => {
    beforeAll(async () => {
        await resetKafka(extraServerConfig)
    })

    beforeEach(async () => {
        await resetTestDatabaseClickhouse(extraServerConfig)
    })

    createProcessEventTests('clickhouse', extraServerConfig, (response) => {
        test('mergePeople kafka messages are only enqueued after all postgres steps succeed', async () => {
            const { hub } = response

            const team = await getFirstTeam(hub!)
            const p0 = await createPerson(hub!, team, ['person_0'], { $os: 'Microsoft' })

            await hub!.db.updatePerson(p0, { created_at: DateTime.fromISO('2020-01-01T00:00:00Z') })

            const p1 = await createPerson(hub!, team, ['person_1'], { $os: 'Chrome', $browser: 'Chrome' })

            await hub!.db.updatePerson(p1, { created_at: DateTime.fromISO('2019-07-01T00:00:00Z') })

            expect((await hub!.db.fetchPersons()).length).toEqual(2)
            const [person0, person1] = await hub!.db.fetchPersons()

            jest.spyOn(hub!.db, 'updatePerson').mockImplementationOnce(() => {
                throw new Error('updatePerson error')
            })

            hub!.db.kafkaProducer!.queueMessage = jest.fn()

            await expect(async () => {
                await hub!.eventsProcessor!.mergePeople({
                    mergeInto: person0,
                    mergeIntoDistinctId: 'person_0',
                    otherPerson: person1,
                    otherPersonDistinctId: 'person_1',
                    totalMergeAttempts: 0,
                })
            }).rejects.toThrow()

            expect(hub!.db.kafkaProducer!.queueMessage).not.toHaveBeenCalled()

            await hub!.eventsProcessor!.mergePeople({
                mergeInto: person0,
                mergeIntoDistinctId: 'person_0',
                otherPerson: person1,
                otherPersonDistinctId: 'person_1',
                totalMergeAttempts: 0,
            })

            // moveDistinctIds 2x, deletePerson 1x
            expect(hub!.db.kafkaProducer!.queueMessage).toHaveBeenCalledTimes(3)

            await resetTestDatabase()
        })
    })
})
