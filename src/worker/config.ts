import { PluginsServerConfig } from '../types'

export function createConfig(serverConfig: PluginsServerConfig, filename: string): Record<string, any> {
    return { filename, workerData: { serverConfig } }
}
