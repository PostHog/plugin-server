import { PluginsServerConfig } from './types'
import { setLogLevel } from './utils'
import { defaultConfig } from './config'

export function initApp(config: PluginsServerConfig) {
    setLogLevel(config.LOG_LEVEL || defaultConfig.LOG_LEVEL)
}
