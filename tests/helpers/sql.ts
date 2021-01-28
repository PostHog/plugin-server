import { makePluginObjects, commonOrganizationId, commonUserId, commonOrganizationMembershipId } from './plugins'
import { defaultConfig } from '../../src/config'
import { Pool } from 'pg'
import { delay, UUIDT } from '../../src/utils'

export async function resetTestDatabase(code: string): Promise<void> {
    const db = new Pool({ connectionString: defaultConfig.DATABASE_URL })
    const mocks = makePluginObjects(code)
    await db.query('DELETE FROM posthog_sessionrecordingevent')
    await db.query('DELETE FROM posthog_persondistinctid')
    await db.query('DELETE FROM posthog_person')
    await db.query('DELETE FROM posthog_event')
    await db.query('DELETE FROM posthog_pluginstorage')
    await db.query('DELETE FROM posthog_pluginattachment')
    await db.query('DELETE FROM posthog_pluginconfig')
    await db.query('DELETE FROM posthog_plugin')
    await db.query('DELETE FROM posthog_team')
    await db.query('DELETE FROM posthog_organizationmembership')
    await db.query('DELETE FROM posthog_organization')
    await db.query('DELETE FROM posthog_user')

    const teamIds = mocks.pluginConfigRows.map((c) => c.team_id)
    await insertRow(db, 'posthog_user', {
        id: commonUserId,
        password: 'gibberish',
        first_name: 'PluginTest',
        last_name: 'User',
        email: 'test@posthog.com',
        distinct_id: 'plugin_test_user_distinct_id',
        is_staff: false,
        is_active: false,
        date_joined: new Date().toISOString(),
    })
    await insertRow(db, 'posthog_organization', {
        id: commonOrganizationId,
        name: 'TEST ORG',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    })
    await insertRow(db, 'posthog_organizationmembership', {
        id: commonOrganizationMembershipId,
        organization_id: commonOrganizationId,
        user_id: commonUserId,
        level: 15,
        joined_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    })
    for (const teamId of teamIds) {
        await insertRow(db, 'posthog_team', {
            id: teamId,
            organization_id: commonOrganizationId,
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
            plugins_opt_in: true,
            opt_out_capture: false,
            is_demo: false,
        })
    }
    for (const plugin of mocks.pluginRows) {
        await insertRow(db, 'posthog_plugin', plugin)
    }
    for (const pluginConfig of mocks.pluginConfigRows) {
        await insertRow(db, 'posthog_pluginconfig', pluginConfig)
    }
    for (const pluginAttachment of mocks.pluginAttachmentRows) {
        await insertRow(db, 'posthog_pluginattachment', pluginAttachment)
    }
    await delay(400)
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
