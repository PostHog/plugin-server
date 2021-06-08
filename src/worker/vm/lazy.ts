import { RetryError } from '@posthog/plugin-scaffold'
import equal from 'fast-deep-equal'

import {
    Hub,
    PluginCapabilities,
    PluginConfig,
    PluginConfigVMResponse,
    PluginLogEntrySource,
    PluginLogEntryType,
    PluginTask,
    PluginTaskType,
    VMMethods,
} from '../../types'
import { clearError, processError } from '../../utils/db/error'
import { disablePlugin, setPluginCapabilities } from '../../utils/db/sql'
import { status } from '../../utils/status'
import { createPluginConfigVM } from './vm'

const MAX_SETUP_RETRIES = 15
const INITIALIZATION_RETRY_MULTIPLIER = 2
const INITIALIZATION_RETRY_BASE_MS = 3000

export class LazyPluginVM {
    initialize?: (hub: Hub, pluginConfig: PluginConfig, indexJs: string, logInfo: string) => Promise<void>
    failInitialization?: () => void
    resolveInternalVm!: Promise<PluginConfigVMResponse | null>
    totalAttemptsToInitialize: number
    retryTimeout: NodeJS.Timeout | null

    constructor() {
        this.totalAttemptsToInitialize = 0
        this.retryTimeout = null
        this.initVm()
    }

    private initVm() {
        this.totalAttemptsToInitialize++
        this.resolveInternalVm = new Promise((resolve) => {
            this.initialize = async (hub: Hub, pluginConfig: PluginConfig, indexJs: string, logInfo = '') => {
                const createPluginLogEntry = async (
                    message: string,
                    logType = PluginLogEntryType.Info
                ): Promise<void> => {
                    await hub.db.createPluginLogEntry(
                        pluginConfig,
                        PluginLogEntrySource.System,
                        logType,
                        message,
                        hub.instanceId
                    )
                }
                try {
                    const vm = await createPluginConfigVM(hub, pluginConfig, indexJs)
                    await createPluginLogEntry(`Plugin loaded (instance ID ${hub.instanceId}).`)
                    status.info('🔌', `Loaded ${logInfo}`)
                    void clearError(hub, pluginConfig)
                    await this.inferPluginCapabilities(hub, pluginConfig, vm)
                    resolve(vm)
                } catch (error) {
                    const isRetryError = error instanceof RetryError
                    status.warn('⚠️', error.message)
                    if (isRetryError && this.totalAttemptsToInitialize < MAX_SETUP_RETRIES) {
                        const nextRetryMs =
                            INITIALIZATION_RETRY_MULTIPLIER ** this.totalAttemptsToInitialize *
                            INITIALIZATION_RETRY_BASE_MS
                        const nextRetrySeconds = `${Math.round(nextRetryMs / 1000)}s`
                        status.warn(
                            '⚠️',
                            `Failed to load ${logInfo}. Retrying to initialize it in ${nextRetrySeconds}.`
                        )
                        await createPluginLogEntry(
                            `Plugin failed to load but its initialization will be retried in ${nextRetrySeconds} (instance ID ${hub.instanceId}).`,
                            PluginLogEntryType.Error
                        )
                        this.retryTimeout = setTimeout(() => {
                            this.initVm()
                            void this.initialize?.(hub, pluginConfig, indexJs, logInfo)
                        }, nextRetryMs)
                        resolve(null)
                        return
                    }
                    const totalAttemptsToInitializeLogMessage = `The server tried to initialize it ${
                        this.totalAttemptsToInitialize
                    } time${this.totalAttemptsToInitialize > 1 ? 's' : ''} before disabling it.`
                    status.warn('⚠️', `Failed to load ${logInfo}. ${totalAttemptsToInitializeLogMessage}`)
                    const additionalContextOnFailure = isRetryError ? totalAttemptsToInitializeLogMessage : ''
                    await createPluginLogEntry(
                        `Plugin failed to load and was disabled (instance ID ${hub.instanceId}). ${additionalContextOnFailure}`,
                        PluginLogEntryType.Error
                    )
                    void disablePlugin(hub, pluginConfig.id)

                    void processError(hub, pluginConfig, error)
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

    async getTeardownPlugin(): Promise<PluginConfigVMResponse['methods']['teardownPlugin'] | null> {
        return (await this.resolveInternalVm)?.methods.teardownPlugin || null
    }

    async getTask(name: string, type: PluginTaskType): Promise<PluginTask | null> {
        return (await this.resolveInternalVm)?.tasks?.[type]?.[name] || null
    }

    async getTasks(type: PluginTaskType): Promise<Record<string, PluginTask>> {
        return (await this.resolveInternalVm)?.tasks?.[type] || {}
    }

    clearRetryTimeoutIfExists() {
        if (this.retryTimeout) {
            clearTimeout(this.retryTimeout)
        }
    }

    private async inferPluginCapabilities(
        hub: Hub,
        pluginConfig: PluginConfig,
        vm: PluginConfigVMResponse
    ): Promise<void> {
        if (!pluginConfig.plugin) {
            throw new Error(`'PluginConfig missing plugin: ${pluginConfig}`)
        }

        const capabilities: Required<PluginCapabilities> = { scheduled_tasks: [], jobs: [], methods: [] }

        const tasks = vm?.tasks
        const methods = vm?.methods

        if (methods) {
            for (const [key, value] of Object.entries(methods)) {
                if (value as VMMethods[keyof VMMethods] | undefined) {
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
            await setPluginCapabilities(hub, pluginConfig, capabilities)
            pluginConfig.plugin.capabilities = capabilities
        }
    }
}
