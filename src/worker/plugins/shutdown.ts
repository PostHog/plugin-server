import { processError } from '../../shared/error'
import { PluginsServer } from '../../types'

export async function shutdownPlugins(server: PluginsServer): Promise<void> {
    const { pluginConfigs } = server

    const shutdownPromises = []
    for (const [id, pluginConfig] of pluginConfigs) {
        if (pluginConfig.vm) {
            const shutdown = await pluginConfig.vm.getShutdown()
            if (shutdown) {
                shutdownPromises.push(
                    (async () => {
                        try {
                            await shutdown()
                        } catch (error) {
                            await processError(server, pluginConfig, error)
                        }
                    })()
                )
            }
        }
    }

    await Promise.all(shutdownPromises)
}
