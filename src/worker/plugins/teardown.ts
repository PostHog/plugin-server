import { processError } from '../../shared/error'
import { PluginConfig, PluginLogEntryType, PluginsServer } from '../../types'

export async function teardownPlugins(server: PluginsServer, pluginConfig?: PluginConfig): Promise<void> {
    const pluginConfigs = pluginConfig ? [pluginConfig] : server.pluginConfigs.values()

    const teardownPromises: Promise<void>[] = []
    for (const pluginConfig of pluginConfigs) {
        if (pluginConfig.vm) {
            const teardownPlugin = await pluginConfig.vm.getTeardownPlugin()
            if (teardownPlugin) {
                teardownPromises.push(
                    (async () => {
                        try {
                            await teardownPlugin()

                            if (server.ENABLE_PERSISTENT_CONSOLE) {
                                await server.db.createPluginLogEntry(
                                    pluginConfig,
                                    PluginLogEntryType.Info,
                                    true,
                                    `Plugin unloaded (instance ID ${server.instanceId}).`,
                                    server.instanceId
                                )
                            }
                        } catch (error) {
                            await processError(server, pluginConfig, error)

                            if (server.ENABLE_PERSISTENT_CONSOLE) {
                                await server.db.createPluginLogEntry(
                                    pluginConfig,
                                    PluginLogEntryType.Error,
                                    true,
                                    `Plugin failed to unload (instance ID ${server.instanceId}).`,
                                    server.instanceId
                                )
                            }
                        }
                    })()
                )
            } else if (server.ENABLE_PERSISTENT_CONSOLE) {
                await server.db.createPluginLogEntry(
                    pluginConfig,
                    PluginLogEntryType.Info,
                    true,
                    `Plugin unloaded (instance ID ${server.instanceId}).`,
                    server.instanceId
                )
            }
        }
    }

    await Promise.all(teardownPromises)
}
