import { Hub, PluginConfig, PluginLogEntrySource, PluginLogEntryType } from '../../types'
import { processError } from '../../utils/db/error'

export async function teardownPlugins(server: Hub, pluginConfig?: PluginConfig): Promise<void> {
    const pluginConfigs = pluginConfig ? [pluginConfig] : server.pluginConfigs.values()

    const teardownPromises: Promise<void>[] = []
    for (const pluginConfig of pluginConfigs) {
        if (pluginConfig.vm) {
            pluginConfig.vm.clearRetryTimeoutIfExists()
            const teardownPlugin = await pluginConfig.vm.getTeardownPlugin()
            if (teardownPlugin) {
                teardownPromises.push(
                    (async () => {
                        try {
                            await teardownPlugin()
                            server.logsBuffer.addLog({
                                pluginConfig,
                                source: PluginLogEntrySource.System,
                                type: PluginLogEntryType.Info,
                                message: `Plugin unloaded (instance ID ${server.instanceId}).`,
                                instanceId: server.instanceId,
                            })
                        } catch (error) {
                            await processError(server, pluginConfig, error)
                            server.logsBuffer.addLog({
                                pluginConfig,
                                source: PluginLogEntrySource.System,
                                type: PluginLogEntryType.Info,
                                message: `Plugin failed to unload (instance ID ${server.instanceId}).`,
                                instanceId: server.instanceId,
                            })
                        }
                    })()
                )
            } else {
                await server.logsBuffer.addLog({
                    pluginConfig,
                    source: PluginLogEntrySource.System,
                    type: PluginLogEntryType.Info,
                    message: `Plugin unloaded (instance ID ${server.instanceId}).`,
                    instanceId: server.instanceId,
                })
            }
        }
    }

    await Promise.all(teardownPromises)
}
