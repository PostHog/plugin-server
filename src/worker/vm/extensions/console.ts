import { ConsoleExtension } from '@posthog/plugin-scaffold'
import { captureException } from '@sentry/minimal'

import { KAFKA_PLUGIN_LOG_ENTRIES } from '../../../shared/ingestion/topics'
import { UUIDT } from '../../../shared/utils'
import { PluginConfig, PluginLogEntry, PluginLogEntryType, PluginsServer } from '../../../types'

export function createConsole(server: PluginsServer, pluginConfig: PluginConfig): ConsoleExtension {
    function consoleRegister(type: PluginLogEntryType, ...args: unknown[]): void {
        const entry: PluginLogEntry = {
            id: new UUIDT().toString(),
            team_id: pluginConfig.team_id,
            plugin_id: pluginConfig.plugin_id,
            timestamp: new Date().toISOString().replace('T', ' ').replace('Z', ''),
            type,
            message: args.map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : arg)).join(' '),
            instance_id: server.instanceId.toString(),
        }

        if (server.db.kafkaProducer) {
            void server.db.kafkaProducer
                .queueMessage({
                    topic: KAFKA_PLUGIN_LOG_ENTRIES,
                    messages: [{ key: entry.id, value: Buffer.from(JSON.stringify(entry)) }],
                })
                .catch(captureException)
        } else {
            void server.db
                .postgresQuery(
                    'INSERT INTO posthog_pluginlogentry (id, team_id, plugin_id, timestamp, type, message, instance_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                    Object.values(entry),
                    'insertPluginLogEntry'
                )
                .catch(captureException)
        }
    }

    return {
        debug: (...args) => consoleRegister(PluginLogEntryType.Debug, ...args),
        log: (...args) => consoleRegister(PluginLogEntryType.Log, ...args),
        info: (...args) => consoleRegister(PluginLogEntryType.Info, ...args),
        warn: (...args) => consoleRegister(PluginLogEntryType.Warn, ...args),
        error: (...args) => consoleRegister(PluginLogEntryType.Error, ...args),
    }
}
