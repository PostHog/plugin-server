import {
    PluginsServer,
    Team,
    Event,
    Person,
    PersonDistinctId,
    Element,
    PostgresSessionRecordingEvent,
} from '../../src/types'
import { DateTime } from 'luxon'
import { UUIDT } from '../../src/utils'
import { createProcessEventTests } from '../shared/process-event.test'

jest.setTimeout(600000) // 600 sec timeout

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

describe('process event (postgresql)', () => {
    createProcessEventTests('postgresql', {
        getSessionRecordingEvents,
        getEvents,
        getPersons,
        getDistinctIds,
        getElements,
    })
})
