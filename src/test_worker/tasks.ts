import { PluginEvent } from '@posthog/plugin-scaffold/src/types'

import { Action, EnqueuedJob, Hub, PluginConfigId, PluginId, PluginTaskType, Team } from '../types'
import { workerTasks as originalWorkerTasks } from '../worker/tasks'
import { ingestEvent } from './ingestion/ingest-event'
import { runSetupPlugin } from './plugins/run'
import { loadSchedule, setupPlugin } from './plugins/setup'
import { teardownPlugins } from './plugins/teardown'

type TaskRunner = (hub: Hub, args: any) => Promise<any> | any

export const workerTasks: Record<string, TaskRunner> = {
    ...originalWorkerTasks,
    setupPlugin: (hub, args: { pluginId: PluginId; pluginConfigId: PluginConfigId }) => {
        return runSetupPlugin(hub, args.event)
    },
    reloadPlugins: async (hub) => {
        await runSetupPlugin(hub, hub.pluginConfigs) // TODO: figure how this should be setup
    },
}
