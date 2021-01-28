import { PluginEvent, Properties } from '@posthog/plugin-scaffold/src/types'
import { createServer } from '../../src/server'
import { LogLevel, PluginsServer, Team, Event, Person, PersonDistinctId } from '../../src/types'
import { resetTestDatabase } from '../helpers/sql'
import { EventsProcessor } from '../../src/ingestion/process-event'
import { DateTime } from 'luxon'
import { UUIDT } from '../../src/utils'

jest.setTimeout(600000) // 600 sec timeout

let team: Team
let server: PluginsServer
let stopServer: () => Promise<void>
let eventsProcessor: EventsProcessor
let now = DateTime.utc()

function createEvent(event = {}): PluginEvent {
    return {
        distinct_id: 'my_id',
        ip: '127.0.0.1',
        site_url: 'http://localhost',
        team_id: 2,
        now: now?.toISO() || new Date().toISOString(),
        event: 'default event',
        properties: {},
        ...event,
    }
}

async function getServer(): Promise<[PluginsServer, () => Promise<void>]> {
    const [server, stopServer] = await createServer({
        PLUGINS_CELERY_QUEUE: 'test-plugins-celery-queue',
        CELERY_DEFAULT_QUEUE: 'test-celery-default-queue',
        LOG_LEVEL: LogLevel.Log,
    })

    await server.redis.del(server.PLUGINS_CELERY_QUEUE)
    await server.redis.del(server.CELERY_DEFAULT_QUEUE)
    return [server, stopServer]
}

beforeEach(async () => {
    const testCode = `
        function processEvent (event, meta) {
            event.properties["somewhere"] = "over the rainbow";
            return event
        }
    `
    await resetTestDatabase(testCode)
    ;[server, stopServer] = await getServer()
    eventsProcessor = new EventsProcessor(server)
    team = (await server.db.postgresQuery('SELECT * FROM posthog_team LIMIT 1')).rows[0]
    now = DateTime.utc()
})

afterEach(async () => {
    await stopServer?.()
})

async function getEvents(): Promise<Event[]> {
    const result = await server.db.postgresQuery('SELECT * FROM posthog_event')
    return result.rows as Event[]
}

async function getPersons(): Promise<Person[]> {
    const result = await server.db.postgresQuery('SELECT * FROM posthog_person')
    return result.rows as Person[]
}

async function getDistinctIds(person: Person) {
    const result = await server.db.postgresQuery(
        'SELECT * FROM posthog_persondistinctid WHERE person_id=$1 and team_id=$2',
        [person.id, person.team_id]
    )
    return (result.rows as PersonDistinctId[]).map((pdi) => pdi.distinct_id)
}

async function createPerson(team: Team, distinctIds: string[]) {
    const person = await server.db.createPerson(DateTime.utc(), {}, team.id, null, false, new UUIDT().toString())
    for (const distinctId of distinctIds) {
        await server.db.addDistinctId(person, distinctId)
    }

    return person
}

test('capture no element', async () => {
    await createPerson(team, ['asdfasdfasdf'])

    await eventsProcessor.processEvent(
        'asdfasdfasdf',
        '',
        '',
        ({
            event: '$pageview',
            properties: { distinct_id: 'asdfasdfasdf', token: team.api_token },
        } as any) as PluginEvent,
        team.id,
        DateTime.utc(),
        DateTime.utc(),
        new UUIDT().toString()
    )

    expect(await getDistinctIds((await getPersons())[0])).toEqual(['asdfasdfasdf'])
    const [event] = await getEvents()
    expect(event.event).toBe('$pageview')
})

test('long event name substr', async () => {
    await eventsProcessor.processEvent(
        'xxx',
        '',
        '',
        ({ event: 'E'.repeat(300), properties: { price: 299.99, name: 'AirPods Pro' } } as any) as PluginEvent,
        team.id,
        DateTime.utc(),
        DateTime.utc(),
        'uuid'
    )

    const [event] = await getEvents()
    expect(event.event?.length).toBe(200)
})
