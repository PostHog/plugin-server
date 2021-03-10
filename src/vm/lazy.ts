import { clearError, processError } from '../error'
import { status } from '../status'
import { LazyPluginVM, PluginConfig, PluginsServer } from '../types'
import { createPluginConfigVM } from './vm'

export function createLazyPluginVM(
    server: PluginsServer,
    pluginConfig: PluginConfig,
    indexJs: string,
    libJs = '',
    logInfo = ''
): LazyPluginVM {
    const promise = createPluginConfigVM(server, pluginConfig, indexJs, libJs)
        .then((vm) => {
            status.info('🔌', `Loaded ${logInfo}`)
            void clearError(server, pluginConfig)
            return vm
        })
        .catch((error) => {
            console.warn(`⚠️ Failed to load ${logInfo}`)
            void processError(server, pluginConfig, error)
            return null
        })

    return {
        promise,
        getProcessEvent: async () => (await promise)?.methods.processEvent || null,
        getProcessEventBatch: async () => (await promise)?.methods.processEventBatch || null,
        getTask: async (name: string) => (await promise)?.tasks[name] || null,
        getTasks: async () => (await promise)?.tasks || {},
    }
}
