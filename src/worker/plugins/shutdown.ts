import { PluginsServer } from '../../types'

export async function shutdownPlugins(server: PluginsServer): Promise<void> {
    const { pluginConfigs } = server

    const shutdownPromises = []
    for (const [id, pluginConfig] of pluginConfigs) {
        if (pluginConfig.vm) {
            const shutdown = await pluginConfig.vm.getShutdown()
            if (shutdown) {
                shutdownPromises.push(shutdown())
            }
        }
    }

    await Promise.all(shutdownPromises)
}
