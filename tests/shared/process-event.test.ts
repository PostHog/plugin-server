import { PluginEvent } from '@posthog/plugin-scaffold/src/types'
import { createServer } from '../../src/server'
import {
    LogLevel,
    PluginsServer,
    Team,
    Event,
    Person,
    PersonDistinctId,
    Element,
    PostgresSessionRecordingEvent,
} from '../../src/types'
import { createUserTeamAndOrganization, resetTestDatabase } from '../helpers/sql'
import { EventsProcessor } from '../../src/ingestion/process-event'
import { DateTime } from 'luxon'
import { UUIDT } from '../../src/utils'

jest.setTimeout(600000) // 600 sec timeout

export const createProcessEventTests = (
    database: 'postgresql' | 'clickhouse',
    {
        getSessionRecordingEvents,
        getEvents,
        getPersons,
        getDistinctIds,
        getTeams,
        getFirstTeam,
        getElements,
        createPerson,
    }: {
        getSessionRecordingEvents: (server: PluginsServer) => Promise<PostgresSessionRecordingEvent[]>
        getEvents: (server: PluginsServer) => Promise<Event[]>
        getPersons: (server: PluginsServer) => Promise<Person[]>
        getDistinctIds: (server: PluginsServer, person: Person) => Promise<string[]>
        getTeams: (server: PluginsServer) => Promise<Team[]>
        getFirstTeam: (server: PluginsServer) => Promise<Team>
        getElements: (server: PluginsServer, event: Event) => Promise<Element[]>
        createPerson: (
            server: PluginsServer,
            team: Team,
            distinctIds: string[],
            properties?: Record<string, any>
        ) => Promise<Person>
    }
) => {
    let queryCounter = 0
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

        const query = server.postgres.query.bind(server.postgres)
        server.postgres.query = (queryText: any, values?: any, callback?: any): any => {
            queryCounter++
            return query(queryText, values, callback)
        }

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
        queryCounter = 0
        team = await getFirstTeam(server)
        now = DateTime.utc()
    })

    afterEach(async () => {
        await stopServer?.()
    })

    test('capture new person', async () => {
        await server.db.postgresQuery(`UPDATE posthog_team SET ingested_event = $1 WHERE id = $2`, [true, team.id])
        team = await getFirstTeam(server)

        expect(team.event_names).toEqual([])

        await eventsProcessor.processEvent(
            '2',
            '',
            '',
            ({
                event: '$autocapture',
                properties: {
                    distinct_id: 2,
                    token: team.api_token,
                    $elements: [
                        { tag_name: 'a', nth_child: 1, nth_of_type: 2, attr__class: 'btn btn-sm' },
                        { tag_name: 'div', nth_child: 1, nth_of_type: 2, $el_text: '💻' },
                    ],
                },
            } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )

        expect(queryCounter).toBe(12)

        // TODO: 12 vs 28 is a big difference. Why so?
        // num_queries = 28
        // if settings.EE_AVAILABLE:  # extra queries to check for hooks
        //     num_queries += 4
        // if settings.MULTI_TENANCY:  # extra query to check for billing plan
        //     num_queries += 1
        // with self.assertNumQueries(num_queries):

        // capture a second time to verify e.g. event_names is not ['$autocapture', '$autocapture']
        await eventsProcessor.processEvent(
            '2',
            '',
            '',
            ({
                event: '$autocapture',
                properties: {
                    distinct_id: 2,
                    token: team.api_token,
                    $elements: [
                        { tag_name: 'a', nth_child: 1, nth_of_type: 2, attr__class: 'btn btn-sm' },
                        { tag_name: 'div', nth_child: 1, nth_of_type: 2, $el_text: '💻' },
                    ],
                },
            } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )

        const events = await getEvents(server)
        const persons = await getPersons(server)
        expect(events.length).toEqual(2)
        expect(persons.length).toEqual(1)

        const [event] = events
        const [person] = persons
        const distinctIds = await getDistinctIds(server, person)

        expect(event.distinct_id).toEqual('2')
        expect(distinctIds).toEqual(['2'])
        expect(event.event).toEqual('$autocapture')
        expect(event.elements_hash).toEqual('0679137c0cd2408a2906839143e7a71f')

        const elements = await getElements(server, event)
        expect(elements[0].tag_name).toEqual('a')
        expect(elements[0].attr_class).toEqual(['btn', 'btn-sm'])
        expect(elements[1].order).toEqual(1)
        expect(elements[1].text).toEqual('💻')

        team = await getFirstTeam(server)
        expect(team.event_names).toEqual(['$autocapture'])
        expect(team.event_names_with_usage).toEqual([{ event: '$autocapture', volume: null, usage_count: null }])
        expect(team.event_properties).toEqual(['distinct_id', 'token', '$ip'])
        expect(team.event_properties_with_usage).toEqual([
            { key: 'distinct_id', usage_count: null, volume: null },
            { key: 'token', usage_count: null, volume: null },
            { key: '$ip', usage_count: null, volume: null },
        ])
    })

    test('capture no element', async () => {
        await createPerson(server, team, ['asdfasdfasdf'])

        await eventsProcessor.processEvent(
            'asdfasdfasdf',
            '',
            '',
            ({
                event: '$pageview',
                properties: { distinct_id: 'asdfasdfasdf', token: team.api_token },
            } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )

        expect(await getDistinctIds(server, (await getPersons(server))[0])).toEqual(['asdfasdfasdf'])
        const [event] = await getEvents(server)
        expect(event.event).toBe('$pageview')
    })

    test('capture sent_at', async () => {
        await createPerson(server, team, ['asdfasdfasdf'])

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

        const [event] = await getEvents(server)
        const eventSecondsBeforeNow = rightNow.diff(DateTime.fromISO(event.timestamp), 'seconds').seconds

        expect(eventSecondsBeforeNow).toBeGreaterThan(590)
        expect(eventSecondsBeforeNow).toBeLessThan(610)
    })

    test('capture sent_at no timezones', async () => {
        await createPerson(server, team, ['asdfasdfasdf'])

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

        const [event] = await getEvents(server)
        const eventSecondsBeforeNow = rightNow.diff(DateTime.fromISO(event.timestamp), 'seconds').seconds

        expect(eventSecondsBeforeNow).toBeGreaterThan(590)
        expect(eventSecondsBeforeNow).toBeLessThan(610)
    })

    test('capture no sent_at', async () => {
        await createPerson(server, team, ['asdfasdfasdf'])

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

        const [event] = await getEvents(server)
        const difference = tomorrow.diff(DateTime.fromISO(event.timestamp), 'seconds').seconds
        expect(difference).toBeLessThan(1)
    })

    test('ip capture', async () => {
        await createPerson(server, team, ['asdfasdfasdf'])

        await eventsProcessor.processEvent(
            'asdfasdfasdf',
            '11.12.13.14',
            '',
            ({
                event: '$pageview',
                properties: { distinct_id: 'asdfasdfasdf', token: team.api_token },
            } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )
        const [event] = await getEvents(server)
        expect(event.properties['$ip']).toBe('11.12.13.14')
    })

    test('ip override', async () => {
        await createPerson(server, team, ['asdfasdfasdf'])

        await eventsProcessor.processEvent(
            'asdfasdfasdf',
            '11.12.13.14',
            '',
            ({
                event: '$pageview',
                properties: { $ip: '1.0.0.1', distinct_id: 'asdfasdfasdf', token: team.api_token },
            } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )
        const [event] = await getEvents(server)
        expect(event.properties['$ip']).toBe('1.0.0.1')
    })

    test('anonymized ip capture', async () => {
        await server.db.postgresQuery('update posthog_team set anonymize_ips = $1', [true])
        await createPerson(server, team, ['asdfasdfasdf'])

        await eventsProcessor.processEvent(
            'asdfasdfasdf',
            '11.12.13.14',
            '',
            ({
                event: '$pageview',
                properties: { distinct_id: 'asdfasdfasdf', token: team.api_token },
            } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )
        const [event] = await getEvents(server)
        expect(event.properties['$ip']).not.toBeDefined()
    })

    test('alias', async () => {
        await createPerson(server, team, ['old_distinct_id'])

        await eventsProcessor.processEvent(
            'new_distinct_id',
            '',
            '',
            ({
                event: '$create_alias',
                properties: { distinct_id: 'new_distinct_id', token: team.api_token, alias: 'old_distinct_id' },
            } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )

        expect((await getEvents(server)).length).toBe(1)
        expect(await getDistinctIds(server, (await getPersons(server))[0])).toEqual([
            'old_distinct_id',
            'new_distinct_id',
        ])
    })

    test('alias reverse', async () => {
        await createPerson(server, team, ['old_distinct_id'])

        await eventsProcessor.processEvent(
            'old_distinct_id',
            '',
            '',
            ({
                event: '$create_alias',
                properties: { distinct_id: 'old_distinct_id', token: team.api_token, alias: 'new_distinct_id' },
            } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )

        expect((await getEvents(server)).length).toBe(1)
        expect(await getDistinctIds(server, (await getPersons(server))[0])).toEqual([
            'old_distinct_id',
            'new_distinct_id',
        ])
    })

    test('alias twice', async () => {
        await createPerson(server, team, ['old_distinct_id'])

        await eventsProcessor.processEvent(
            'new_distinct_id',
            '',
            '',
            ({
                event: '$create_alias',
                properties: { distinct_id: 'new_distinct_id', token: team.api_token, alias: 'old_distinct_id' },
            } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )

        expect((await getPersons(server)).length).toBe(1)
        expect((await getEvents(server)).length).toBe(1)
        expect(await getDistinctIds(server, (await getPersons(server))[0])).toEqual([
            'old_distinct_id',
            'new_distinct_id',
        ])

        await createPerson(server, team, ['old_distinct_id_2'])
        expect((await getPersons(server)).length).toBe(2)

        await eventsProcessor.processEvent(
            'new_distinct_id',
            '',
            '',
            ({
                event: '$create_alias',
                properties: { distinct_id: 'new_distinct_id', token: team.api_token, alias: 'old_distinct_id_2' },
            } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )
        expect((await getEvents(server)).length).toBe(2)
        expect((await getPersons(server)).length).toBe(1)
        expect(await getDistinctIds(server, (await getPersons(server))[0])).toEqual([
            'old_distinct_id',
            'new_distinct_id',
            'old_distinct_id_2',
        ])
    })

    test('alias before person', async () => {
        await eventsProcessor.processEvent(
            'new_distinct_id',
            '',
            '',
            ({
                event: '$create_alias',
                properties: { distinct_id: 'new_distinct_id', token: team.api_token, alias: 'old_distinct_id' },
            } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )

        expect((await getEvents(server)).length).toBe(1)
        expect((await getPersons(server)).length).toBe(1)
        expect(await getDistinctIds(server, (await getPersons(server))[0])).toEqual([
            'new_distinct_id',
            'old_distinct_id',
        ])
    })

    test('alias both existing', async () => {
        await createPerson(server, team, ['old_distinct_id'])
        await createPerson(server, team, ['new_distinct_id'])

        await eventsProcessor.processEvent(
            'new_distinct_id',
            '',
            '',
            ({
                event: '$create_alias',
                properties: { distinct_id: 'new_distinct_id', token: team.api_token, alias: 'old_distinct_id' },
            } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )

        expect((await getEvents(server)).length).toBe(1)
        expect(await getDistinctIds(server, (await getPersons(server))[0])).toEqual([
            'old_distinct_id',
            'new_distinct_id',
        ])
    })

    test('offset timestamp', async () => {
        now = DateTime.fromISO('2020-01-01T12:00:05.200Z')

        await eventsProcessor.processEvent(
            'distinct_id',
            '',
            '',
            ({ offset: 150, event: '$autocapture', distinct_id: 'distinct_id' } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )
        expect((await getEvents(server)).length).toBe(1)

        const [event] = await getEvents(server)
        expect(event.timestamp).toEqual('2020-01-01T12:00:05.050Z')
    })

    test('offset timestamp no sent_at', async () => {
        now = DateTime.fromISO('2020-01-01T12:00:05.200Z')

        await eventsProcessor.processEvent(
            'distinct_id',
            '',
            '',
            ({ offset: 150, event: '$autocapture', distinct_id: 'distinct_id' } as any) as PluginEvent,
            team.id,
            now,
            null,
            new UUIDT().toString()
        )
        expect((await getEvents(server)).length).toBe(1)

        const [event] = await getEvents(server)
        expect(event.timestamp).toEqual('2020-01-01T12:00:05.050Z')
    })

    test('alias merge properties', async () => {
        await createPerson(server, team, ['old_distinct_id'], {
            key_on_both: 'old value both',
            key_on_old: 'old value',
        })
        await createPerson(server, team, ['new_distinct_id'], {
            key_on_both: 'new value both',
            key_on_new: 'new value',
        })

        await eventsProcessor.processEvent(
            'new_distinct_id',
            '',
            '',
            ({
                event: '$create_alias',
                properties: { distinct_id: 'new_distinct_id', token: team.api_token, alias: 'old_distinct_id' },
            } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )

        expect((await getEvents(server)).length).toBe(1)
        expect((await getPersons(server)).length).toBe(1)
        const [person] = await getPersons(server)
        expect(await getDistinctIds(server, person)).toEqual(['old_distinct_id', 'new_distinct_id'])
        expect(person.properties).toEqual({
            key_on_both: 'new value both',
            key_on_new: 'new value',
            key_on_old: 'old value',
        })
    })

    test('long htext', async () => {
        await eventsProcessor.processEvent(
            'new_distinct_id',
            '',
            '',
            ({
                event: '$autocapture',
                properties: {
                    distinct_id: 'new_distinct_id',
                    token: team.api_token,
                    $elements: [
                        {
                            tag_name: 'a',
                            $el_text: 'a'.repeat(2050),
                            attr__href: 'a'.repeat(2050),
                            nth_child: 1,
                            nth_of_type: 2,
                            attr__class: 'btn btn-sm',
                        },
                    ],
                },
            } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )

        const [event] = await getEvents(server)
        expect(event.elements_hash).toEqual('c2659b28e72835706835764cf7f63c2a')
        const [element] = await getElements(server, event)
        expect(element.href?.length).toEqual(2048)
        expect(element.text?.length).toEqual(400)
    })

    test('capture first team event', async () => {
        await server.db.postgresQuery(`UPDATE posthog_team SET ingested_event = $1 WHERE id = $2`, [false, team.id])

        eventsProcessor.posthog = {
            identify: jest.fn((distinctId) => true),
            capture: jest.fn((event, properties) => true),
        } as any

        await eventsProcessor.processEvent(
            '2',
            '',
            '',
            ({
                event: '$autocapture',
                properties: {
                    distinct_id: 1,
                    token: team.api_token,
                    $elements: [{ tag_name: 'a', nth_child: 1, nth_of_type: 2, attr__class: 'btn btn-sm' }],
                },
            } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )

        expect(eventsProcessor.posthog.identify).toHaveBeenCalledWith('plugin_test_user_distinct_id_1001')
        expect(eventsProcessor.posthog.capture).toHaveBeenCalledWith('first team event ingested', {
            team: team.uuid,
        })

        team = await getFirstTeam(server)
        expect(team.ingested_event).toEqual(true)

        const [event] = await getEvents(server)
        expect(event.elements_hash).toEqual('a89021a60b3497d24e93ae181fba01aa')
    })

    test('snapshot event stored as session_recording_event', async () => {
        await eventsProcessor.processEvent(
            'some-id',
            '',
            '',
            ({
                event: '$snapshot',
                properties: { $session_id: 'abcf-efg', $snapshot_data: { timestamp: 123 } },
            } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )

        const events = await getEvents(server)
        expect(events.length).toEqual(0)

        const sessionRecordingEvents = await getSessionRecordingEvents(server)
        expect(sessionRecordingEvents.length).toBe(1)

        const [event] = sessionRecordingEvents
        expect(event.session_id).toEqual('abcf-efg')
        expect(event.distinct_id).toEqual('some-id')
        expect(event.snapshot_data).toEqual({ timestamp: 123 })
    })

    test('identify set', async () => {
        await createPerson(server, team, ['distinct_id'])

        await eventsProcessor.processEvent(
            'distinct_id',
            '',
            '',
            ({
                event: '$identify',
                properties: {
                    token: team.api_token,
                    distinct_id: 'distinct_id',
                    $set: { a_prop: 'test-1', c_prop: 'test-1' },
                },
            } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )

        expect((await getEvents(server)).length).toBe(1)

        const [event] = await getEvents(server)
        expect(event.properties['$set']).toEqual({ a_prop: 'test-1', c_prop: 'test-1' })

        const [person] = await getPersons(server)
        expect(await getDistinctIds(server, person)).toEqual(['distinct_id'])
        expect(person.properties).toEqual({ a_prop: 'test-1', c_prop: 'test-1' })
        expect(person.is_identified).toEqual(true)

        await eventsProcessor.processEvent(
            'distinct_id',
            '',
            '',
            ({
                event: '$identify',
                properties: {
                    token: team.api_token,
                    distinct_id: 'distinct_id',
                    $set: { a_prop: 'test-2', b_prop: 'test-2b' },
                },
            } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )
        expect((await getEvents(server)).length).toBe(2)
        const [person2] = await getPersons(server)
        expect(person2.properties).toEqual({ a_prop: 'test-2', b_prop: 'test-2b', c_prop: 'test-1' })
    })

    test('identify set_once', async () => {
        await createPerson(server, team, ['distinct_id'])

        await eventsProcessor.processEvent(
            'distinct_id',
            '',
            '',
            ({
                event: '$identify',
                properties: {
                    token: team.api_token,
                    distinct_id: 'distinct_id',
                    $set_once: { a_prop: 'test-1', c_prop: 'test-1' },
                },
            } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )

        expect((await getEvents(server)).length).toBe(1)

        const [event] = await getEvents(server)
        expect(event.properties['$set_once']).toEqual({ a_prop: 'test-1', c_prop: 'test-1' })

        const [person] = await getPersons(server)
        expect(await getDistinctIds(server, person)).toEqual(['distinct_id'])
        expect(person.properties).toEqual({ a_prop: 'test-1', c_prop: 'test-1' })
        expect(person.is_identified).toEqual(true)

        await eventsProcessor.processEvent(
            'distinct_id',
            '',
            '',
            ({
                event: '$identify',
                properties: {
                    token: team.api_token,
                    distinct_id: 'distinct_id',
                    $set_once: { a_prop: 'test-2', b_prop: 'test-2b' },
                },
            } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )
        expect((await getEvents(server)).length).toBe(2)
        const [person2] = await getPersons(server)
        expect(person2.properties).toEqual({ a_prop: 'test-1', b_prop: 'test-2b', c_prop: 'test-1' })
    })

    test('distinct with anonymous_id', async () => {
        await createPerson(server, team, ['anonymous_id'])

        await eventsProcessor.processEvent(
            'new_distinct_id',
            '',
            '',
            ({
                event: '$identify',
                properties: {
                    $anon_distinct_id: 'anonymous_id',
                    token: team.api_token,
                    distinct_id: 'new_distinct_id',
                    $set: { a_prop: 'test' },
                },
            } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )

        expect((await getEvents(server)).length).toBe(1)
        const [event] = await getEvents(server)
        expect(event.properties['$set']).toEqual({ a_prop: 'test' })
        const [person] = await getPersons(server)
        expect(await getDistinctIds(server, person)).toEqual(['anonymous_id', 'new_distinct_id'])
        expect(person.properties).toEqual({ a_prop: 'test' })

        // check no errors as this call can happen multiple times
        await eventsProcessor.processEvent(
            'new_distinct_id',
            '',
            '',
            ({
                event: '$identify',
                properties: {
                    $anon_distinct_id: 'anonymous_id',
                    token: team.api_token,
                    distinct_id: 'new_distinct_id',
                    $set: { a_prop: 'test' },
                },
            } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )
    })

    // This case is likely to happen after signup, for example:
    // 1. User browses website with anonymous_id
    // 2. User signs up, triggers event with their new_distinct_id (creating a new Person)
    // 3. In the frontend, try to alias anonymous_id with new_distinct_id
    // Result should be that we end up with one Person with both ID's
    test('distinct with anonymous_id which was already created', async () => {
        await createPerson(server, team, ['anonymous_id'])
        await createPerson(server, team, ['new_distinct_id'], { email: 'someone@gmail.com' })

        await eventsProcessor.processEvent(
            'new_distinct_id',
            '',
            '',
            ({
                event: '$identify',
                properties: {
                    $anon_distinct_id: 'anonymous_id',
                    token: team.api_token,
                    distinct_id: 'new_distinct_id',
                },
            } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )

        const [person] = await getPersons(server)
        expect(await getDistinctIds(server, person)).toEqual(['anonymous_id', 'new_distinct_id'])
        expect(person.properties['email']).toEqual('someone@gmail.com')
    })

    test('distinct with multiple anonymous_ids which were already created', async () => {
        await createPerson(server, team, ['anonymous_id'])
        await createPerson(server, team, ['new_distinct_id'], { email: 'someone@gmail.com' })

        await eventsProcessor.processEvent(
            'new_distinct_id',
            '',
            '',
            ({
                event: '$identify',
                properties: {
                    $anon_distinct_id: 'anonymous_id',
                    token: team.api_token,
                    distinct_id: 'new_distinct_id',
                },
            } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )

        const persons1 = await getPersons(server)
        expect(persons1.length).toBe(1)
        expect(await getDistinctIds(server, persons1[0])).toEqual(['anonymous_id', 'new_distinct_id'])
        expect(persons1[0].properties['email']).toEqual('someone@gmail.com')

        await createPerson(server, team, ['anonymous_id_2'])

        await eventsProcessor.processEvent(
            'new_distinct_id',
            '',
            '',
            ({
                event: '$identify',
                properties: {
                    $anon_distinct_id: 'anonymous_id_2',
                    token: team.api_token,
                    distinct_id: 'new_distinct_id',
                },
            } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )

        const persons2 = await getPersons(server)
        expect(persons2.length).toBe(1)
        expect(await getDistinctIds(server, persons2[0])).toEqual(['anonymous_id', 'new_distinct_id', 'anonymous_id_2'])
        expect(persons2[0].properties['email']).toEqual('someone@gmail.com')
    })

    test('distinct team leakage', async () => {
        await createUserTeamAndOrganization(
            server.postgres,
            3,
            1002,
            '01774e2f-0d01-0000-ee94-9a238640c6ee',
            '0174f81e-36f5-0000-7ef8-cc26c1fbab1c'
        )
        const team2 = (await getTeams(server))[1]
        await createPerson(server, team2, ['2'], { email: 'team2@gmail.com' })
        await createPerson(server, team, ['1', '2'])

        await eventsProcessor.processEvent(
            '2',
            '',
            '',
            ({
                event: '$identify',
                properties: {
                    $anon_distinct_id: '1',
                    token: team.api_token,
                    distinct_id: '2',
                },
            } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )

        const people = await getPersons(server)
        expect(people.length).toEqual(2)
        expect(people[1].team_id).toEqual(team.id)
        expect(people[1].properties).toEqual({})
        expect(await getDistinctIds(server, people[1])).toEqual(['1', '2'])
        expect(people[0].team_id).toEqual(team2.id)
        expect(await getDistinctIds(server, people[0])).toEqual(['2'])
    })

    test('set is_identified', async () => {
        const distinct_id = '777'
        const person1 = await createPerson(server, team, [distinct_id])
        expect(person1.is_identified).toBe(false)

        await eventsProcessor.processEvent(
            distinct_id,
            '',
            '',
            ({ event: '$identify', properties: {} } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )

        const [person2] = await getPersons(server)
        expect(person2.is_identified).toBe(true)
    })

    test('team event_properties', async () => {
        expect(team.event_properties_numerical).toEqual([])

        await eventsProcessor.processEvent(
            'xxx',
            '',
            '',
            ({ event: 'purchase', properties: { price: 299.99, name: 'AirPods Pro' } } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )

        team = await getFirstTeam(server)
        expect(team.event_properties).toEqual(['price', 'name', '$ip'])
        expect(team.event_properties_numerical).toEqual(['price'])
    })

    test('event name object json', async () => {
        await eventsProcessor.processEvent(
            'xxx',
            '',
            '',
            ({ event: { 'event name': 'as object' }, properties: {} } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )
        const [event] = await getEvents(server)
        expect(event.event).toEqual('{"event name":"as object"}')
    })

    test('event name array json', async () => {
        await eventsProcessor.processEvent(
            'xxx',
            '',
            '',
            ({ event: ['event name', 'a list'], properties: {} } as any) as PluginEvent,
            team.id,
            now,
            now,
            new UUIDT().toString()
        )
        const [event] = await getEvents(server)
        expect(event.event).toEqual('["event name","a list"]')
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

        const [event] = await getEvents(server)
        expect(event.event?.length).toBe(200)
    })
}
