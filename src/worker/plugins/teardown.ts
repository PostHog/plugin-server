import { processError } from '../../shared/error'
import { PluginConfig, PluginsServer } from '../../types'

export async function teardownPlugins(
    server: PluginsServer,
    pluginConfigs: PluginConfig[] | undefined = undefined
): Promise<void> {
    if (!pluginConfigs) {
        pluginConfigs = Array.from(server.pluginConfigs.values())
    }

    const teardownPromises: Promise<void>[] = []
    for (const pluginConfig of pluginConfigs) {
        if (pluginConfig.vm) {
            const teardownPlugin = await pluginConfig.vm.getTeardownPlugin()
            if (teardownPlugin) {
                teardownPromises.push(
                    (async () => {
                        try {
                            await teardownPlugin()
                        } catch (error) {
                            await processError(server, pluginConfig, error)
                        }
                    })()
                )
            }
        }
    }

    await Promise.all(teardownPromises)
}
