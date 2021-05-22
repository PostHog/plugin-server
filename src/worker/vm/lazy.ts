import {
    PluginConfig,
    PluginConfigVMResponse,
    PluginLogEntrySource,
    PluginLogEntryType,
    PluginsServer,
    PluginTask,
    PluginTaskType,
} from '../../types'
import { clearError, processError } from '../../utils/db/error'
import { disablePlugin } from '../../utils/db/sql'
import { status } from '../../utils/status'
import { createPluginConfigVM } from './vm'

export class LazyPluginVM {
    initialize?: (server: PluginsServer, pluginConfig: PluginConfig, indexJs: string, logInfo: string) => Promise<void>
    failInitialization?: () => void
    resolveInternalVm: Promise<PluginConfigVMResponse | null>

    constructor() {
        this.resolveInternalVm = new Promise((resolve) => {
            this.initialize = async (
                server: PluginsServer,
                pluginConfig: PluginConfig,
                indexJs: string,
                logInfo = ''
            ) => {
                try {
                    const vm = await createPluginConfigVM(server, pluginConfig, indexJs)
                    await server.db.createPluginLogEntry(
                        pluginConfig,
                        PluginLogEntrySource.System,
                        PluginLogEntryType.Info,
                        `Plugin loaded (instance ID ${server.instanceId}).`,
                        server.instanceId
                    )
                    status.info('🔌', `Loaded ${logInfo}`)
                    void clearError(server, pluginConfig)
                    resolve(vm)
                } catch (error) {
                    await server.db.createPluginLogEntry(
                        pluginConfig,
                        PluginLogEntrySource.System,
                        PluginLogEntryType.Error,
                        `Plugin failed to load and was disabled (instance ID ${server.instanceId}).`,
                        server.instanceId
                    )
                    status.warn('⚠️', `Failed to load ${logInfo}`)
                    void disablePlugin(server, pluginConfig.id)
                    void processError(server, pluginConfig, error)
                    resolve(null)
                }
            }
            this.failInitialization = () => {
                resolve(null)
            }
        })
    }

    async getExportEvents(): Promise<PluginConfigVMResponse['methods']['exportEvents'] | null> {
        return (await this.resolveInternalVm)?.methods.exportEvents || null
    }

    async getOnEvent(): Promise<PluginConfigVMResponse['methods']['onEvent'] | null> {
        return (await this.resolveInternalVm)?.methods.onEvent || null
    }

    async getOnSnapshot(): Promise<PluginConfigVMResponse['methods']['onSnapshot'] | null> {
        return (await this.resolveInternalVm)?.methods.onSnapshot || null
    }

    async getProcessEvent(): Promise<PluginConfigVMResponse['methods']['processEvent'] | null> {
        return (await this.resolveInternalVm)?.methods.processEvent || null
    }

    async getProcessEventBatch(): Promise<PluginConfigVMResponse['methods']['processEventBatch'] | null> {
        return (await this.resolveInternalVm)?.methods.processEventBatch || null
    }

    async getTeardownPlugin(): Promise<PluginConfigVMResponse['methods']['teardownPlugin'] | null> {
        return (await this.resolveInternalVm)?.methods.teardownPlugin || null
    }

    async getTask(name: string, type: PluginTaskType): Promise<PluginTask | null> {
        return (await this.resolveInternalVm)?.tasks?.[type]?.[name] || null
    }

    async getTasks(type: PluginTaskType): Promise<Record<string, PluginTask>> {
        return (await this.resolveInternalVm)?.tasks?.[type] || {}
    }
}
