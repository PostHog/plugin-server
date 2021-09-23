import { DateTime } from 'luxon'

import { ClickHousePerson, Database, Hub, Person, PropertyOperator } from '../../src/types'
import { DB } from '../../src/utils/db/db'
import { createHub } from '../../src/utils/db/hub'
import { delay, UUIDT } from '../../src/utils/utils'
import { resetTestDatabase } from '../helpers/sql'
import { delayUntilEventIngested } from './process-event'

describe('DB', () => {
    let hub: Hub
    let closeServer: () => Promise<void>
    let db: DB

    beforeEach(async () => {
        ;[hub, closeServer] = await createHub()
        await resetTestDatabase()
        db = hub.db
    })

    afterEach(async () => {
        await closeServer()
    })

    const TEAM_ID = 2
    const ACTION_ID = 69
    const ACTION_STEP_ID = 913

    test('fetchAllActionsGroupedByTeam', async () => {
        const action = await db.fetchAllActionsGroupedByTeam()

        expect(action).toMatchObject({
            [TEAM_ID]: {
                [ACTION_ID]: {
                    id: ACTION_ID,
                    name: 'Test Action',
                    deleted: false,
                    post_to_slack: true,
                    slack_message_format: '',
                    is_calculating: false,
                    steps: [
                        {
                            id: ACTION_STEP_ID,
                            action_id: ACTION_ID,
                            tag_name: null,
                            text: null,
                            href: null,
                            selector: null,
                            url: null,
                            url_matching: null,
                            name: null,
                            event: null,
                            properties: [
                                { type: 'event', operator: PropertyOperator.Exact, key: 'foo', value: ['bar'] },
                            ],
                        },
                    ],
                },
            },
        })
    })

    test('setPersonAsIdentified', async () => {
        const uuid = new UUIDT().toString()
        const person = await hub.db.createPerson(
            DateTime.utc(),
            {},
            TEAM_ID,
            null,
            false, // not identified
            uuid,
            ['distinct1']
        )

        await delayUntilEventIngested(() => hub.db.fetchPersons(), 1)

        if (hub.db.kafkaProducer) {
            await delayUntilEventIngested(() => hub.db.fetchPersons(Database.ClickHouse), 1)
        }

        await hub.db.setPersonAsIdentified(person)

        await delay(5000)

        let persons: Person[] | ClickHousePerson[] = []
        if (hub.db.kafkaProducer) {
            persons = await hub.db.fetchPersons(Database.ClickHouse)
        } else {
            persons = await hub.db.fetchPersons()
        }

        expect(Boolean(persons[0].is_identified)).toBe(true)
    })
})
