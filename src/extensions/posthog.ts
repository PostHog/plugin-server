import { PluginsServer, PluginConfig } from 'types'
import { version } from '../../package.json'
import Client from '../celery/client'

export function createPostHog(server: PluginsServer, pluginConfig: PluginConfig) {
    const state = {
        distinctId: `${pluginConfig.plugin?.name} (${pluginConfig.id})`,
    }
    return {
        init(distinctId: string) {
            state.distinctId = distinctId
        },
        capture(event: string, properties: Record<string, any> = {}) {
            const client = new Client(server.redis, server.PLUGINS_CELERY_QUEUE)

            const data = {
                distinct_id: state.distinctId,
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
                [state.distinctId, null, null, data, pluginConfig.team_id, new Date(), new Date()],
                {}
            )
        },
    }
}
