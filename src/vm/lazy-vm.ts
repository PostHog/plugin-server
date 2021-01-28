import { PluginConfig, PluginConfigLazyVMReponse, PluginConfigVMReponse, PluginsServer, PluginTask } from '../types'
import { createPluginConfigVM } from './vm'
import { VM } from 'vm2'
import { PluginEvent } from '@posthog/plugin-scaffold/src/types'
import { status } from '../status'
import { clearError, processError } from '../error'

export function createLazyPluginConfigVM(
    server: PluginsServer,
    pluginConfig: PluginConfig, // NB! might have team_id = 0
    indexJs: string,
    libJs = ''
): PluginConfigLazyVMReponse {
    let originalResponse: PluginConfigVMReponse
    let originalResponsePromise: Promise<PluginConfigVMReponse>

    let methods: {
        processEvent: (event: PluginEvent) => Promise<PluginEvent>
        processEventBatch: (batch: PluginEvent[]) => Promise<PluginEvent[]>
    }

    const awaitVm = async () => {
        if (originalResponse) {
            return originalResponse
        }
        if (originalResponsePromise) {
            return await originalResponsePromise
        }
        originalResponsePromise = createPluginConfigVM(server, pluginConfig, indexJs, libJs)
        try {
            originalResponse = await originalResponsePromise
            response.tasks = originalResponse.tasks
            response.methods = originalResponse.methods
            status.info(
                '🔌',
                `Loaded plugin "${pluginConfig?.plugin?.name || `config ${pluginConfig.id}`}" (team ${
                    pluginConfig.team_id
                })!`
            )
            await clearError(server, pluginConfig)
            return originalResponse
        } catch (error) {
            await processError(server, pluginConfig, error)
            throw error
        }
    }

    const response: PluginConfigLazyVMReponse = {
        async vm(): Promise<VM> {
            return (await awaitVm()).vm
        },
        async ready(): Promise<boolean> {
            try {
                await awaitVm()
                return true
            } catch (e) {
                return false
            }
        },
        methods: {
            async processEvent(event: PluginEvent): Promise<PluginEvent> {
                if (originalResponse) {
                    return originalResponse.methods.processEvent(event)
                }
                return (await awaitVm()).methods.processEvent(event)
            },
            async processEventBatch(batch: PluginEvent[]): Promise<PluginEvent[]> {
                if (originalResponse) {
                    return originalResponse.methods.processEventBatch(batch)
                }
                return (await awaitVm()).methods.processEventBatch(batch)
            },
        },
        tasks: {} as Record<string, PluginTask>,
    }

    return response
}
