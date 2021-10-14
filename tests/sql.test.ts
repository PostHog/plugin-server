import { Hub, PersonPropertyUpdateOperation, PluginConfig, PluginError, Team } from '../src/types'
import { createHub } from '../src/utils/db/hub'
import {
    disablePlugin,
    getPluginAttachmentRows,
    getPluginConfigRows,
    getPluginRows,
    setError,
    setPluginMetrics,
} from '../src/utils/db/sql'
import { commonOrganizationId } from './helpers/plugins'
import { getFirstTeam, resetTestDatabase } from './helpers/sql'
import { createPerson } from './shared/process-event'

let hub: Hub
let closeHub: () => Promise<void>
let team: Team

const FUTURE_TIMESTAMP = '2050-10-14T11:42:06.502Z'
const PAST_TIMESTAMP = '2000-10-14T11:42:06.502Z'
const NOW = new Date().toISOString()

beforeEach(async () => {
    ;[hub, closeHub] = await createHub()
    await resetTestDatabase(`const processEvent = event => event`)
    team = await getFirstTeam(hub)
})

afterEach(async () => {
    await closeHub()
})

test('getPluginAttachmentRows', async () => {
    const rowsExpected = [
        {
            content_type: 'application/octet-stream',
            contents: Buffer.from([116, 101, 115, 116]),
            file_name: 'test.txt',
            file_size: 4,
            id: 42666,
            key: 'maxmindMmdb',
            plugin_config_id: 39,
            team_id: 2,
        },
    ]

    const rows1 = await getPluginAttachmentRows(hub)
    expect(rows1).toEqual(rowsExpected)
    await hub.db.postgresQuery("update posthog_team set plugins_opt_in='f'", undefined, 'testTag')
    const rows2 = await getPluginAttachmentRows(hub)
    expect(rows2).toEqual(rowsExpected)
})

test('getPluginConfigRows', async () => {
    const rowsExpected = [
        {
            config: {
                localhostIP: '94.224.212.175',
            },
            enabled: true,
            error: null,
            id: 39,
            order: 0,
            plugin_id: 60,
            team_id: 2,
            created_at: expect.anything(),
            updated_at: expect.anything(),
        },
    ]

    const rows1 = await getPluginConfigRows(hub)
    expect(rows1).toEqual(rowsExpected)
    await hub.db.postgresQuery("update posthog_team set plugins_opt_in='f'", undefined, 'testTag')
    const rows2 = await getPluginConfigRows(hub)
    expect(rows2).toEqual(rowsExpected)
})

test('getPluginRows', async () => {
    const rowsExpected = [
        {
            archive: expect.any(Buffer),
            config_schema: {
                localhostIP: {
                    default: '',
                    hint: 'Useful if testing locally',
                    name: 'IP to use instead of 127.0.0.1',
                    order: 2,
                    required: false,
                    type: 'string',
                },
                maxmindMmdb: {
                    hint: 'The "GeoIP2 City" or "GeoLite2 City" database file',
                    markdown:
                        'Sign up for a [MaxMind.com](https://www.maxmind.com) account, download and extract the database and then upload the `.mmdb` file below',
                    name: 'GeoIP .mddb database',
                    order: 1,
                    required: true,
                    type: 'attachment',
                },
            },
            description: 'Ingest GeoIP data via MaxMind',
            error: null,
            from_json: false,
            from_web: false,
            id: 60,
            is_global: false,
            is_preinstalled: false,
            organization_id: commonOrganizationId,
            latest_tag: null,
            latest_tag_checked_at: null,
            name: 'test-maxmind-plugin',
            plugin_type: 'custom',
            source: null,
            tag: '0.0.2',
            url: 'https://www.npmjs.com/package/posthog-maxmind-plugin',
            created_at: expect.anything(),
            updated_at: expect.anything(),
            capabilities: {},
            metrics: {},
        },
    ]

    const rows1 = await getPluginRows(hub)
    expect(rows1).toEqual(rowsExpected)
    await hub.db.postgresQuery("update posthog_team set plugins_opt_in='f'", undefined, 'testTag')
    const rows2 = await getPluginRows(hub)
    expect(rows2).toEqual(rowsExpected)
})

test('setError', async () => {
    const pluginConfig39: PluginConfig = {
        id: 39,
        team_id: 2,
        plugin_id: 60,
        enabled: true,
        order: 0,
        config: {},
        error: undefined,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    }
    hub.db.postgresQuery = jest.fn() as any

    await setError(hub, null, pluginConfig39)
    expect(hub.db.postgresQuery).toHaveBeenCalledWith(
        'UPDATE posthog_pluginconfig SET error = $1 WHERE id = $2',
        [null, pluginConfig39.id],
        'updatePluginConfigError'
    )

    const pluginError: PluginError = { message: 'error happened', time: 'now' }
    await setError(hub, pluginError, pluginConfig39)
    expect(hub.db.postgresQuery).toHaveBeenCalledWith(
        'UPDATE posthog_pluginconfig SET error = $1 WHERE id = $2',
        [pluginError, pluginConfig39.id],
        'updatePluginConfigError'
    )
})

describe('disablePlugin', () => {
    test('disablePlugin query builds correctly', async () => {
        hub.db.postgresQuery = jest.fn() as any

        await disablePlugin(hub, 39)
        expect(hub.db.postgresQuery).toHaveBeenCalledWith(
            `UPDATE posthog_pluginconfig SET enabled='f' WHERE id=$1 AND enabled='t'`,
            [39],
            'disablePlugin'
        )
    })

    test('disablePlugin disables a plugin', async () => {
        const rowsBefore = await getPluginConfigRows(hub)
        expect(rowsBefore[0].plugin_id).toEqual(60)
        expect(rowsBefore[0].enabled).toEqual(true)

        await disablePlugin(hub, 39)

        const rowsAfter = await getPluginConfigRows(hub)
        expect(rowsAfter).toEqual([])
    })
})

describe('setPluginMetrics', () => {
    test('setPluginMetrics sets metrics correctly', async () => {
        const pluginConfig39: PluginConfig = {
            id: 39,
            team_id: 2,
            plugin_id: 60,
            enabled: true,
            order: 0,
            config: {},
            error: undefined,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        }

        const rowsBefore = await getPluginRows(hub)
        expect(rowsBefore[0].id).toEqual(60)
        expect(rowsBefore[0].metrics).toEqual({})

        await setPluginMetrics(hub, pluginConfig39, { metric1: 'sum' })

        const rowsAfter = await getPluginRows(hub)
        expect(rowsAfter[0].metrics).toEqual({ metric1: 'sum' })
    })
})

describe('updatePersonProperties', () => {
    //  How we expect this query to behave:
    //   | call     | value exists  | call TS is ___ existing TS | previous fn | write/override
    //  1| set      | no            | N/A                        | N/A         | yes
    //  2| set_once | no            | N/A                        | N/A         | yes
    //  3| set      | yes           | before                     | set         | no
    //  4| set      | yes           | before                     | set_once    | yes
    //  5| set      | yes           | after                      | set         | yes
    //  6| set      | yes           | after                      | set_once    | yes
    //  7| set_once | yes           | before                     | set         | no
    //  8| set_once | yes           | before                     | set_once    | yes
    //  9| set_once | yes           | after                      | set         | no
    // 10| set_once | yes           | after                      | set_once    | no
    // 11| set      | yes           | equal                      | set         | no
    // 12| set_once | yes           | equal                      | set         | no
    // 13| set      | yes           | equal                      | set_once    | no
    // 14| set_once | yes           | equal                      | set_once    | no

    test('update without properties_last_updated_at', async () => {
        const person = await createPerson(hub, team, ['person_0'], { a: 0, b: 0 }, {}, { a: 'set', b: 'set_once' })

        const newProps = await hub.db.updatePersonProperties(
            person,
            { a: 1, b: 2 },
            { a: PersonPropertyUpdateOperation.Set, b: PersonPropertyUpdateOperation.SetOnce },
            NOW
        )

        // both updated
        expect(newProps).toEqual({ a: 1, b: 2 })
    })

    test('update without properties_last_operation', async () => {
        const person = await createPerson(
            hub,
            team,
            ['person_0'],
            { a: 0, b: 0 },
            { a: FUTURE_TIMESTAMP, b: PAST_TIMESTAMP },
            {}
        )

        const newProps = await hub.db.updatePersonProperties(
            person,
            { a: 1, b: 2 },
            { a: PersonPropertyUpdateOperation.Set, b: PersonPropertyUpdateOperation.SetOnce },
            NOW
        )

        // both updated
        expect(newProps).toEqual({ a: 1, b: 2 })
    })

    test('update non-existent property', async () => {
        const person = await createPerson(hub, team, ['person_0'], {})

        const newProps = await hub.db.updatePersonProperties(
            person,
            { a: 1, b: 2 },
            { a: PersonPropertyUpdateOperation.Set, b: PersonPropertyUpdateOperation.SetOnce },
            NOW
        )

        expect(newProps).toEqual({ a: 1, b: 2 })
    })

    test('set operation with earlier timestamp', async () => {
        const person = await createPerson(
            hub,
            team,
            ['person_0'],
            { a: 0, b: 0 },
            { a: FUTURE_TIMESTAMP, b: FUTURE_TIMESTAMP },
            { a: 'set', b: 'set_once' }
        )

        const newProps = await hub.db.updatePersonProperties(
            person,
            { a: 1, b: 2 },
            { a: PersonPropertyUpdateOperation.Set, b: PersonPropertyUpdateOperation.Set },
            NOW
        )

        // a is not updated, b is
        expect(newProps).toEqual({ a: 0, b: 2 })
    })

    test('set operation with older timestamp', async () => {
        const person = await createPerson(
            hub,
            team,
            ['person_0'],
            { a: 0, b: 0 },
            { a: PAST_TIMESTAMP, b: PAST_TIMESTAMP },
            { a: 'set', b: 'set_once' }
        )

        const newProps = await hub.db.updatePersonProperties(
            person,
            { a: 1, b: 2 },
            { a: PersonPropertyUpdateOperation.Set, b: PersonPropertyUpdateOperation.Set },
            NOW
        )

        // both updated
        expect(newProps).toEqual({ a: 1, b: 2 })
    })

    test('set_once operation with earlier timestamp', async () => {
        const person = await createPerson(
            hub,
            team,
            ['person_0'],
            { a: 0, b: 0 },
            { a: FUTURE_TIMESTAMP, b: FUTURE_TIMESTAMP },
            { a: 'set', b: 'set_once' }
        )

        const newProps = await hub.db.updatePersonProperties(
            person,
            { a: 1, b: 2 },
            { a: PersonPropertyUpdateOperation.SetOnce, b: PersonPropertyUpdateOperation.SetOnce },
            NOW
        )

        // a is not updated, b is
        expect(newProps).toEqual({ a: 0, b: 2 })
    })

    test('set_once operation with older timestamp', async () => {
        const person = await createPerson(
            hub,
            team,
            ['person_0'],
            { a: 0, b: 0 },
            { a: PAST_TIMESTAMP, b: PAST_TIMESTAMP },
            { a: 'set', b: 'set_once' }
        )

        const newProps = await hub.db.updatePersonProperties(
            person,
            { a: 1, b: 2 },
            { a: PersonPropertyUpdateOperation.SetOnce, b: PersonPropertyUpdateOperation.SetOnce },
            NOW
        )

        // neither updated
        expect(newProps).toEqual({ a: 0, b: 0 })
    })

    test('equal timestamps', async () => {
        const person = await createPerson(
            hub,
            team,
            ['person_0'],
            { a: 0, b: 0 },
            { a: NOW, b: NOW },
            { a: 'set', b: 'set_once' }
        )

        const newProps1 = await hub.db.updatePersonProperties(
            person,
            { a: 1, b: 2 },
            { a: PersonPropertyUpdateOperation.SetOnce, b: PersonPropertyUpdateOperation.SetOnce },
            NOW
        )

        // neither updated
        expect(newProps1).toEqual({ a: 0, b: 0 })

        const newProps2 = await hub.db.updatePersonProperties(
            person,
            { a: 1, b: 2 },
            { a: PersonPropertyUpdateOperation.SetOnce, b: PersonPropertyUpdateOperation.SetOnce },
            NOW
        )

        // neither updated
        expect(newProps2).toEqual({ a: 0, b: 0 })
    })

    test('increment will always update', async () => {
        const person = await createPerson(
            hub,
            team,
            ['person_0'],
            { a: 0, b: 0, c: 0, d: 0 },
            { a: PAST_TIMESTAMP, b: FUTURE_TIMESTAMP, c: PAST_TIMESTAMP, d: FUTURE_TIMESTAMP },
            { a: 'set', b: 'set_once', c: 'set_once', d: 'set' }
        )

        const newProps1 = await hub.db.updatePersonProperties(
            person,
            { a: 1, b: 1, c: 1, d: 1 },
            {
                a: PersonPropertyUpdateOperation.Increment,
                b: PersonPropertyUpdateOperation.Increment,
                c: PersonPropertyUpdateOperation.Increment,
                d: PersonPropertyUpdateOperation.Increment,
            },
            NOW
        )

        // all incremented
        expect(newProps1).toEqual({ a: 1, b: 1, c: 1, d: 1 })
    })
})
