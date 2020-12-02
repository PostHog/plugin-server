import { Plugin, PluginAttachmentDB, PluginConfig, PluginError, PluginsServer } from './types'

export async function getPluginRows(server: PluginsServer) {
    const { rows: pluginRows }: { rows: Plugin[] } = await server.db.query(
        "SELECT * FROM posthog_plugin WHERE id in (SELECT plugin_id FROM posthog_pluginconfig WHERE enabled='t' GROUP BY plugin_id)"
    )
    return pluginRows
}

export async function getPluginAttachmentRows(server: PluginsServer) {
    const { rows }: { rows: PluginAttachmentDB[] } = await server.db.query(
        "SELECT * FROM posthog_pluginattachment WHERE plugin_config_id in (SELECT id FROM posthog_pluginconfig WHERE enabled='t')"
    )
    return rows
}

export async function getPluginConfigRows(server: PluginsServer) {
    const { rows }: { rows: PluginConfig[] } = await server.db.query(
        "SELECT * FROM posthog_pluginconfig WHERE enabled='t'"
    )
    return rows
}

export async function setError(server: PluginsServer, pluginError: PluginError | null, pluginConfig: PluginConfig) {
    await server.db.query('UPDATE posthog_pluginconfig SET error = $1 WHERE id = $2', [
        pluginError,
        pluginConfig.id,
    ])
}
