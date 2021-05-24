import { Pool, PoolClient } from 'pg'

import { defaultConfig } from '../../src/config/config'
import {
    Hub,
    Plugin,
    PluginAttachmentDB,
    PluginConfig,
    PluginsServer,
    PluginsServerConfig,
    Team,
} from '../../src/types'
import { UUIDT } from '../../src/utils/utils'
import {
    commonOrganizationId,
    commonOrganizationMembershipId,
    commonUserId,
    commonUserUuid,
    makePluginObjects,
} from './plugins'

export interface ExtraDatabaseRows {
    plugins?: Omit<Plugin, 'id'>[]
    pluginConfigs?: Omit<PluginConfig, 'id'>[]
    pluginAttachments?: Omit<PluginAttachmentDB, 'id'>[]
}

export async function resetTestDatabase(
    code?: string,
    extraServerConfig: Partial<PluginsServerConfig> = {},
    extraRows: ExtraDatabaseRows = {}
): Promise<void> {
    const config = { ...defaultConfig, ...extraServerConfig }
    const db = new Pool({ connectionString: config.DATABASE_URL })
    try {
        await db.query('DELETE FROM ee_hook')
    } catch {}

    await db.query(`
        DELETE FROM posthog_element;
        DELETE FROM posthog_elementgroup;
        DELETE FROM posthog_sessionrecordingevent;
        DELETE FROM posthog_persondistinctid;
        DELETE FROM posthog_person;
        DELETE FROM posthog_event;
        DELETE FROM posthog_pluginstorage;
        DELETE FROM posthog_pluginattachment;
        DELETE FROM posthog_pluginlogentry;
        DELETE FROM posthog_pluginconfig;
        DELETE FROM posthog_plugin;
        DELETE FROM posthog_eventdefinition;
        DELETE FROM posthog_propertydefinition;
        DELETE FROM posthog_team;
        DELETE FROM posthog_organizationmembership;
        DELETE FROM posthog_organization;
        DELETE FROM posthog_user;
    `)

    const mocks = makePluginObjects(code)
    const teamIds = mocks.pluginConfigRows.map((c) => c.team_id)
    await createUserTeamAndOrganization(db, teamIds[0])

    for (const plugin of mocks.pluginRows.concat(extraRows.plugins ?? [])) {
        await insertRow(db, 'posthog_plugin', plugin)
    }
    for (const pluginConfig of mocks.pluginConfigRows.concat(extraRows.pluginConfigs ?? [])) {
        await insertRow(db, 'posthog_pluginconfig', pluginConfig)
    }
    for (const pluginAttachment of mocks.pluginAttachmentRows.concat(extraRows.pluginAttachments ?? [])) {
        await insertRow(db, 'posthog_pluginattachment', pluginAttachment)
    }
    await db.end()
}

async function insertRow(db: Pool, table: string, object: Record<string, any>): Promise<void> {
    const keys = Object.keys(object)
        .map((key) => `"${key}"`)
        .join(',')
    const params = Object.keys(object)
        .map((_, i) => `\$${i + 1}`)
        .join(',')
    try {
        await db.query(`INSERT INTO ${table} (${keys}) VALUES (${params})`, Object.values(object))
    } catch (error) {
        console.error(`Error on table ${table} when inserting object:\n`, object, '\n', error)
        throw error
    }
}

export async function createUserTeamAndOrganization(
    db: Pool,
    teamId: number,
    userId: number = commonUserId,
    userUuid: string = commonUserUuid,
    organizationId: string = commonOrganizationId,
    organizationMembershipId: string = commonOrganizationMembershipId
): Promise<void> {
    await insertRow(db, 'posthog_user', {
        id: userId,
        uuid: userUuid,
        password: 'gibberish',
        first_name: 'PluginTest',
        last_name: 'User',
        email: `test${userId}@posthog.com`,
        distinct_id: `plugin_test_user_distinct_id_${userId}`,
        is_staff: false,
        is_active: false,
        date_joined: new Date().toISOString(),
        events_column_config: { active: 'DEFAULT' },
    })
    await insertRow(db, 'posthog_organization', {
        id: organizationId,
        name: 'TEST ORG',
        plugins_access_level: 9,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        personalization: '{}',
        setup_section_2_completed: true,
        for_internal_metrics: false,
    })
    await insertRow(db, 'posthog_organizationmembership', {
        id: organizationMembershipId,
        organization_id: organizationId,
        user_id: userId,
        level: 15,
        joined_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    })
    await insertRow(db, 'posthog_team', {
        id: teamId,
        organization_id: organizationId,
        app_urls: [],
        name: 'TEST PROJECT',
        event_names: JSON.stringify([]),
        event_names_with_usage: JSON.stringify([]),
        event_properties: JSON.stringify([]),
        event_properties_with_usage: JSON.stringify([]),
        event_properties_numerical: JSON.stringify([]),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        anonymize_ips: false,
        completed_snippet_onboarding: true,
        ingested_event: true,
        uuid: new UUIDT().toString(),
        session_recording_opt_in: true,
        plugins_opt_in: false,
        opt_out_capture: false,
        is_demo: false,
        api_token: `THIS IS NOT A TOKEN FOR TEAM ${teamId}`,
        test_account_filters: [],
        timezone: 'UTC',
        data_attributes: JSON.stringify(['data-attr']),
    })
}

export async function getTeams(hub: Hub): Promise<Team[]> {
    return (await hub.db.postgresQuery('SELECT * FROM posthog_team ORDER BY id', undefined, 'fetchAllTeams')).rows
}

export async function getFirstTeam(hub: Hub): Promise<Team> {
    return (await getTeams(hub))[0]
}

/** Inject code onto `server` which runs a callback whenever a postgres query is performed */
export function onQuery(hub: Hub, onQueryCallback: (queryText: string) => any): void {
    function spyOnQueryFunction(client: any) {
        const query = client.query.bind(client)
        client.query = (queryText: any, values?: any, callback?: any): any => {
            onQueryCallback(queryText)
            return query(queryText, values, callback)
        }
    }

    spyOnQueryFunction(hub.postgres)

    const postgresTransaction = hub.db.postgresTransaction.bind(hub.db)
    hub.db.postgresTransaction = async (transaction: (client: PoolClient) => Promise<any>): Promise<any> => {
        return await postgresTransaction(async (client: PoolClient) => {
            const query = client.query
            spyOnQueryFunction(client)
            const response = await transaction(client)
            client.query = query
            return response
        })
    }
}

export async function getErrorForPluginConfig(id: number): Promise<any> {
    const db = new Pool({ connectionString: defaultConfig.DATABASE_URL })
    let error
    try {
        const response = await db.query('SELECT * FROM posthog_pluginconfig WHERE id = $1', [id])
        error = response.rows[0]['error']
    } catch {}

    await db.end()
    return error
}
