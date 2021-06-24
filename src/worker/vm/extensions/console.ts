import { createBuffer } from '@posthog/plugin-contrib'
import { ConsoleExtension } from '@posthog/plugin-scaffold'

import { Hub, PluginConfig, PluginLogEntrySource, PluginLogEntryType } from '../../../types'
import { status } from '../../../utils/status'
import { determineNodeEnv, NodeEnv, pluginDigest } from '../../../utils/utils'
import { LogEntryPayload } from './../../../utils/db/db'

function consoleFormat(...args: unknown[]): string {
    return args
        .map((arg) => {
            const argString = String(arg)
            if (argString === '[object Object]' || Array.isArray(arg)) {
                return JSON.stringify(arg)
            }
            return argString
        })
        .join(' ')
}

export function createConsole(server: Hub, pluginConfig: PluginConfig): ConsoleExtension {
    const consoleBuffer = createBuffer({
        limit: 100,
        timeoutSeconds: 1,
        onFlush: async (logEntries: LogEntryPayload[]) => {
            await server.db.createPluginLogEntries(pluginConfig, logEntries)
        },
    })

    function consolePersist(type: PluginLogEntryType, ...args: unknown[]): void {
        if (determineNodeEnv() === NodeEnv.Development) {
            status.info('👉', `${type} in ${pluginDigest(pluginConfig.plugin!, pluginConfig.team_id)}:`, ...args)
        }

        consoleBuffer.add({
            type,
            source: PluginLogEntrySource.Console,
            message: consoleFormat(...args),
            instanceId: server.instanceId,
        })

        // insert log entry immediately when testing
        if (determineNodeEnv() === NodeEnv.Test) {
            void consoleBuffer.flush()
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
