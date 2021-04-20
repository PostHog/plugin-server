import { ConsoleExtension } from '@posthog/plugin-scaffold'
import { captureException } from '@sentry/node'

import { KAFKA_PLUGIN_LOG_ENTRIES } from '../../../shared/ingestion/topics'
import { status } from '../../../shared/status'
import { determineNodeEnv, NodeEnv, pluginDigest, UUIDT } from '../../../shared/utils'
import { PluginConfig, PluginLogEntry, PluginLogEntryType, PluginsServer } from '../../../types'

export function createConsole(server: PluginsServer, pluginConfig: PluginConfig): ConsoleExtension {
    async function consolePersist(type: PluginLogEntryType, ...args: unknown[]): Promise<void> {
        if (determineNodeEnv() == NodeEnv.Development) {
            status.info('👉', `${type} in ${pluginDigest(pluginConfig.plugin!, pluginConfig.team_id)}:`, ...args)
        }

        if (!server.ENABLE_PERSISTENT_CONSOLE) {
            return
        }

        args = args.map((arg) => {
            const argString = String(arg)
            return argString === '[object Object]' ? JSON.stringify(arg) : argString
        })

        const entry: PluginLogEntry = {
            id: new UUIDT().toString(),
            team_id: pluginConfig.team_id,
            plugin_id: pluginConfig.plugin_id,
            timestamp: new Date().toISOString().replace('T', ' ').replace('Z', ''),
            type,
            message: args.join(' '),
            instance_id: server.instanceId.toString(),
        }

        if (server.db.kafkaProducer) {
            await server.db.kafkaProducer
                .queueMessage({
                    topic: KAFKA_PLUGIN_LOG_ENTRIES,
                    messages: [{ key: entry.id, value: Buffer.from(JSON.stringify(entry)) }],
                })
                .catch(captureException)
        } else {
            await server.db
                .postgresQuery(
                    'INSERT INTO posthog_pluginlogentry (id, team_id, plugin_id, timestamp, type, message, instance_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                    Object.values(entry),
                    'insertPluginLogEntry'
                )
                .catch(captureException)
        }
    }

    return {
        debug: (...args) => consolePersist(PluginLogEntryType.Debug, ...args),
        log: (...args) => consolePersist(PluginLogEntryType.Log, ...args),
        info: (...args) => consolePersist(PluginLogEntryType.Info, ...args),
        warn: (...args) => consolePersist(PluginLogEntryType.Warn, ...args),
        error: (...args) => consolePersist(PluginLogEntryType.Error, ...args),
    }
}
