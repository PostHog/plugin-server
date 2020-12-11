import { PluginsServer, PluginConfig } from 'types'
import { version } from '../../package.json'
import Client from '../celery/client'

export function createPostHog(server: PluginsServer, pluginConfig: PluginConfig) {
    const distinctId = pluginConfig.plugin?.name || `Plugin ${pluginConfig.plugin_id}`

    function sendEvent(event: string, properties: Record<string, any> = {}) {
        const client = new Client(server.redis, server.PLUGINS_CELERY_QUEUE)

        const data = {
            distinct_id: distinctId,
            event,
            timestamp: new Date(),
            properties: {
                $lib: 'posthog-plugin-server',
                $lib_version: version,
                ...properties,
            },
        }

        client.sendTask(
            'posthog.tasks.process_event.process_event_with_plugins',
            [distinctId, null, null, data, pluginConfig.team_id, new Date(), new Date()],
            {}
        )
    }

    return {
        capture(event: string, properties: Record<string, any> = {}) {
            sendEvent(event, properties)
        },
    }
}
