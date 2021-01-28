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

describe('process event', () => {
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

    test.skip('capture new person', async () => {
        // TODO
    })

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

    test('capture sent_at', async () => {
        await createPerson(team, ['asdfasdfasdf'])

        const rightNow = DateTime.utc()
        const tomorrow = rightNow.plus({ days: 1, hours: 2 })
        const tomorrowSentAt = rightNow.plus({ days: 1, hours: 2, minutes: 10 })

        await eventsProcessor.processEvent(
            'movie played',
            '',
            '',
            ({
                event: '$pageview',
                timestamp: tomorrow.toISO(),
                properties: { distinct_id: 'asdfasdfasdf', token: team.api_token },
            } as any) as PluginEvent,
            team.id,
            rightNow,
            tomorrowSentAt,
            new UUIDT().toString()
        )

        const [event] = await getEvents()
        const eventSecondsBeforeNow = rightNow.diff(DateTime.fromJSDate(event.timestamp), 'seconds').seconds

        expect(eventSecondsBeforeNow).toBeGreaterThan(590)
        expect(eventSecondsBeforeNow).toBeLessThan(610)
    })

    test('capture sent_at no timezones', async () => {
        await createPerson(team, ['asdfasdfasdf'])

        const rightNow = DateTime.utc()
        const tomorrow = rightNow.plus({ days: 1, hours: 2 }).setZone('UTC+4')
        const tomorrowSentAt = rightNow.plus({ days: 1, hours: 2, minutes: 10 }).setZone('UTC+4')

        // TODO: not sure if this is correct?
        // tomorrow = tomorrow.replace(tzinfo=None)
        // tomorrow_sent_at = tomorrow_sent_at.replace(tzinfo=None)

        await eventsProcessor.processEvent(
            'movie played',
            '',
            '',
            ({
                event: '$pageview',
                timestamp: tomorrow,
                properties: { distinct_id: 'asdfasdfasdf', token: team.api_token },
            } as any) as PluginEvent,
            team.id,
            rightNow,
            tomorrowSentAt,
            new UUIDT().toString()
        )

        const [event] = await getEvents()
        const eventSecondsBeforeNow = rightNow.diff(DateTime.fromJSDate(event.timestamp), 'seconds').seconds

        expect(eventSecondsBeforeNow).toBeGreaterThan(590)
        expect(eventSecondsBeforeNow).toBeLessThan(610)
    })

    test('capture no sent_at', async () => {
        await createPerson(team, ['asdfasdfasdf'])

        const rightNow = DateTime.utc()
        const tomorrow = rightNow.plus({ days: 1, hours: 2 })

        await eventsProcessor.processEvent(
            'movie played',
            '',
            '',
            ({
                event: '$pageview',
                timestamp: tomorrow.toISO(),
                properties: { distinct_id: 'asdfasdfasdf', token: team.api_token },
            } as any) as PluginEvent,
            team.id,
            rightNow,
            null,
            new UUIDT().toString()
        )

        const [event] = await getEvents()
        const difference = tomorrow.diff(DateTime.fromJSDate(event.timestamp), 'seconds').seconds
        expect(difference).toBeLessThan(1)
    })

    test('ip capture', async () => {
        await createPerson(team, ['asdfasdfasdf'])

        await eventsProcessor.processEvent(
            'asdfasdfasdf',
            '11.12.13.14',
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
        const [event] = await getEvents()
        expect(event.properties['$ip']).toBe('11.12.13.14')
    })

    test('ip override', async () => {
        await createPerson(team, ['asdfasdfasdf'])

        await eventsProcessor.processEvent(
            'asdfasdfasdf',
            '11.12.13.14',
            '',
            ({
                event: '$pageview',
                properties: { $ip: '1.0.0.1', distinct_id: 'asdfasdfasdf', token: team.api_token },
            } as any) as PluginEvent,
            team.id,
            DateTime.utc(),
            DateTime.utc(),
            new UUIDT().toString()
        )
        const [event] = await getEvents()
        expect(event.properties['$ip']).toBe('1.0.0.1')
    })

    test('anonymized ip capture', async () => {
        await server.db.postgresQuery('update posthog_team set anonymize_ips = $1', [true])
        await createPerson(team, ['asdfasdfasdf'])

        await eventsProcessor.processEvent(
            'asdfasdfasdf',
            '11.12.13.14',
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
        const [event] = await getEvents()
        expect(event.properties['$ip']).not.toBeDefined()
    })

    test('alias', async () => {
        await createPerson(team, ['old_distinct_id'])

        await eventsProcessor.processEvent(
            'new_distinct_id',
            '',
            '',
            ({
                event: '$create_alias',
                properties: { distinct_id: 'new_distinct_id', token: team.api_token, alias: 'old_distinct_id' },
            } as any) as PluginEvent,
            team.id,
            DateTime.utc(),
            DateTime.utc(),
            new UUIDT().toString()
        )

        expect((await getEvents()).length).toBe(1)
        expect(getDistinctIds((await getPersons())[0])).toBe(['old_distinct_id', 'new_distinct_id'])
    })

    test.skip('alias reverse', async () => {
        // TODO
    })

    test.skip('alias twice', async () => {
        // TODO
    })

    test.skip('alias before person', async () => {
        // TODO
    })

    test.skip('alias both existing', async () => {
        // TODO
    })

    test.skip('offset timestamp', async () => {
        // TODO
    })

    test.skip('offset timestamp no sent_at', async () => {
        // TODO
    })

    test.skip('alias merge properties', async () => {
        // TODO
    })

    test.skip('long htext', async () => {
        // TODO
    })

    test.skip('capture first team event', async () => {
        // TODO
    })

    test.skip('snapshot event stored as session_recording_event', async () => {
        // TODO
    })

    test.skip('identify set', async () => {
        // TODO
    })

    test.skip('identify set_once', async () => {
        // TODO
    })

    test.skip('distinct with anonymous_id', async () => {
        // TODO
    })

    test.skip('distinct with anonymous_id which was already created', async () => {
        // TODO
    })

    test.skip('distinct with multiple anonymous_ids which were already created', async () => {
        // TODO
    })

    test.skip('distinct team leakage', async () => {
        // TODO
    })

    test.skip('set is_identified', async () => {
        // TODO
    })

    test.skip('team event_properties', async () => {
        // TODO
    })

    test.skip('add feature flags if missing', async () => {
        // TODO
    })

    test.skip('event name dict json', async () => {
        // TODO
    })

    test.skip('event name list json', async () => {
        // TODO
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
})
