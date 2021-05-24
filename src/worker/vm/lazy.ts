import equal from 'fast-deep-equal'

import {
    PluginCapabilities,
    PluginConfig,
    PluginConfigVMReponse,
    PluginLogEntrySource,
    PluginLogEntryType,
    PluginsServer,
    PluginTask,
    PluginTaskType,
} from '../../types'
import { clearError, processError } from '../../utils/db/error'
import { disablePlugin, setPluginCapabilities } from '../../utils/db/sql'
import { status } from '../../utils/status'
import { createPluginConfigVM } from './vm'

export class LazyPluginVM {
    initialize?: (server: PluginsServer, pluginConfig: PluginConfig, indexJs: string, logInfo: string) => Promise<void>
    failInitialization?: () => void
    resolveInternalVm: Promise<PluginConfigVMReponse | null>

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
                    await this.inferPluginCapabilities(server, pluginConfig, vm)
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

    async getOnEvent(): Promise<PluginConfigVMReponse['methods']['onEvent'] | null> {
        return (await this.resolveInternalVm)?.methods.onEvent || null
    }

    async getOnSnapshot(): Promise<PluginConfigVMReponse['methods']['onSnapshot'] | null> {
        return (await this.resolveInternalVm)?.methods.onSnapshot || null
    }

    async getProcessEvent(): Promise<PluginConfigVMReponse['methods']['processEvent'] | null> {
        return (await this.resolveInternalVm)?.methods.processEvent || null
    }

    async getProcessEventBatch(): Promise<PluginConfigVMReponse['methods']['processEventBatch'] | null> {
        return (await this.resolveInternalVm)?.methods.processEventBatch || null
    }

    async getTeardownPlugin(): Promise<PluginConfigVMReponse['methods']['teardownPlugin'] | null> {
        return (await this.resolveInternalVm)?.methods.teardownPlugin || null
    }

    async getTask(name: string, type: PluginTaskType): Promise<PluginTask | null> {
        return (await this.resolveInternalVm)?.tasks?.[type]?.[name] || null
    }

    async getTasks(type: PluginTaskType): Promise<Record<string, PluginTask>> {
        return (await this.resolveInternalVm)?.tasks?.[type] || {}
    }

    private async inferPluginCapabilities(
        server: PluginsServer,
        pluginConfig: PluginConfig,
        vm: PluginConfigVMReponse
    ): Promise<void> {
        if (!pluginConfig.plugin) {
            throw new Error(`'PluginConfig missing plugin: ${pluginConfig}`)
        }

        const capabilities: Required<PluginCapabilities> = { scheduled_tasks: [], jobs: [], methods: [] }

        const tasks = vm?.tasks
        const methods = vm?.methods

        if (methods) {
            for (const [key, value] of Object.entries(methods)) {
                if (value) {
                    capabilities.methods.push(key)
                }
            }
        }

        if (tasks?.schedule) {
            for (const [key, value] of Object.entries(tasks.schedule)) {
                if (value) {
                    capabilities.scheduled_tasks.push(key)
                }
            }
        }

        if (tasks?.job) {
            for (const [key, value] of Object.entries(tasks.job)) {
                if (value) {
                    capabilities.jobs.push(key)
                }
            }
        }

        const prevCapabilities = pluginConfig.plugin.capabilities
        if (!equal(prevCapabilities, capabilities)) {
            await setPluginCapabilities(server, pluginConfig, capabilities)
            pluginConfig.plugin.capabilities = capabilities
        }
    }
}
