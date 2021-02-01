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

async function getTeams(server: PluginsServer): Promise<Team[]> {
    return (await server.db.postgresQuery('SELECT * FROM posthog_team ORDER BY id')).rows
}

async function getFirstTeam(server: PluginsServer): Promise<Team> {
    return (await getTeams(server))[0]
}

async function getElements(server: PluginsServer, event: Event): Promise<Element[]> {
    return (await server.db.postgresQuery('SELECT * FROM posthog_element')).rows
}

async function createPerson(
    server: PluginsServer,
    team: Team,
    distinctIds: string[],
    properties: Record<string, any> = {}
): Promise<Person> {
    return server.db.createPerson(DateTime.utc(), properties, team.id, null, false, new UUIDT().toString(), distinctIds)
}

describe('process event (postgresql)', () => {
    createProcessEventTests('postgresql', {
        getSessionRecordingEvents,
        getEvents,
        getPersons,
        getDistinctIds,
        getTeams,
        getFirstTeam,
        getElements,
        createPerson,
    })
})
