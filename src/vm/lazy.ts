import { clearError, processError } from '../error'
import { status } from '../status'
import { LazyPluginVM, PluginConfig, PluginsServer } from '../types'
import { createPluginConfigVM } from './vm'

export function createLazyPluginVM(): LazyPluginVM {
    const returnValue: Partial<LazyPluginVM> = {
        getProcessEvent: async () => (await returnValue.promise)?.methods.processEvent || null,
        getProcessEventBatch: async () => (await returnValue.promise)?.methods.processEventBatch || null,
        getTask: async (name: string) => (await returnValue.promise)?.tasks[name] || null,
        getTasks: async () => (await returnValue.promise)?.tasks || {},
    }
    returnValue.promise = new Promise((resolve) => {
        returnValue.initialize = async (
            server: PluginsServer,
            pluginConfig: PluginConfig,
            indexJs: string,
            logInfo = ''
        ) => {
            try {
                const vm = await createPluginConfigVM(server, pluginConfig, indexJs)
                status.info('🔌', `Loaded ${logInfo}`)
                void clearError(server, pluginConfig)
                resolve(vm)
            } catch (error) {
                console.warn(`⚠️ Failed to load ${logInfo}`)
                void processError(server, pluginConfig, error)
                resolve(null)
            }
        }
        returnValue.failInitialization = () => {
            resolve(null)
        }
    })

    return returnValue as LazyPluginVM
}
