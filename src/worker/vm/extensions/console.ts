import { createBuffer } from '@posthog/plugin-contrib'
import { ConsoleExtension } from '@posthog/plugin-scaffold'

import { Hub, PluginConfig, PluginLogEntrySource, PluginLogEntryType } from '../../../types'
import { status } from '../../../utils/status'
import { determineNodeEnv, NodeEnv, pluginDigest } from '../../../utils/utils'

interface ConsoleBuffer {
    type: PluginLogEntryType
    args: any[]
}

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
        timeoutSeconds: 0.1,
        onFlush: async (logs: ConsoleBuffer[]) => {
            for (const { type, args } of logs) {
                await server.db.createPluginLogEntry(
                    pluginConfig,
                    PluginLogEntrySource.Console,
                    type,
                    consoleFormat(...args),
                    server.instanceId
                )
            }
        },
    })

    function consolePersist(type: PluginLogEntryType, ...args: unknown[]) {
        if (determineNodeEnv() === NodeEnv.Development) {
            status.info('👉', `${type} in ${pluginDigest(pluginConfig.plugin!, pluginConfig.team_id)}:`, ...args)
        }

        consoleBuffer.add({
            type,
            args,
        } as ConsoleBuffer)
    }

    return {
        debug: (...args) => consolePersist(PluginLogEntryType.Debug, ...args),
        log: (...args) => consolePersist(PluginLogEntryType.Log, ...args),
        info: (...args) => consolePersist(PluginLogEntryType.Info, ...args),
        warn: (...args) => consolePersist(PluginLogEntryType.Warn, ...args),
        error: (...args) => consolePersist(PluginLogEntryType.Error, ...args),
    }
}
