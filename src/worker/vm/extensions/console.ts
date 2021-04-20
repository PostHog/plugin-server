import { ConsoleExtension } from '@posthog/plugin-scaffold'

import { status } from '../../../shared/status'
import { determineNodeEnv, NodeEnv, pluginDigest } from '../../../shared/utils'
import { PluginConfig, PluginLogEntryType, PluginsServer } from '../../../types'

export function createConsole(server: PluginsServer, pluginConfig: PluginConfig): ConsoleExtension {
    async function consolePersist(type: PluginLogEntryType, ...args: unknown[]): Promise<void> {
        if (determineNodeEnv() == NodeEnv.Development) {
            status.info('👉', `${type} in ${pluginDigest(pluginConfig.plugin!, pluginConfig.team_id)}:`, ...args)
        }

        if (!server.ENABLE_PERSISTENT_CONSOLE) {
            return
        }

        const message = args
            .map((arg) => {
                const argString = String(arg)
                return argString === '[object Object]' ? JSON.stringify(arg, null, 4) : argString
            })
            .join(' ')

        await server.db.createPluginLogEntry(pluginConfig, type, message, server.instanceId)
    }

    return {
        debug: (...args) => consolePersist(PluginLogEntryType.Debug, ...args),
        log: (...args) => consolePersist(PluginLogEntryType.Log, ...args),
        info: (...args) => consolePersist(PluginLogEntryType.Info, ...args),
        warn: (...args) => consolePersist(PluginLogEntryType.Warn, ...args),
        error: (...args) => consolePersist(PluginLogEntryType.Error, ...args),
    }
}
