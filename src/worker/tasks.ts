import { PluginEvent } from '@posthog/plugin-scaffold/src/types'

import { Action, EnqueuedJob, Hub, PluginTaskType, Team } from '../types'
import { ingestEvent } from './ingestion/ingest-event'
import { runOnEvent, runOnSnapshot, runPluginTask, runProcessEvent, runProcessEventBatch } from './plugins/run'
import { loadSchedule, setupPlugins } from './plugins/setup'
import { teardownPlugins } from './plugins/teardown'

type TaskRunner = (hub: Hub, args: any) => Promise<any> | any

export const workerTasks: Record<string, TaskRunner> = {
    onEvent: (hub, args: { event: PluginEvent }) => {
        return runOnEvent(hub, args.event)
    },
    onSnapshot: (hub, args: { event: PluginEvent }) => {
        return runOnSnapshot(hub, args.event)
    },
    processEvent: (hub, args: { event: PluginEvent }) => {
        return runProcessEvent(hub, args.event)
    },
    processEventBatch: (hub, args: { batch: PluginEvent[] }) => {
        return runProcessEventBatch(hub, args.batch)
    },
    runJob: (hub, { job }: { job: EnqueuedJob }) => {
        return runPluginTask(hub, job.type, PluginTaskType.Job, job.pluginConfigId, job.payload)
    },
    runEveryMinute: (hub, args: { pluginConfigId: number }) => {
        return runPluginTask(hub, 'runEveryMinute', PluginTaskType.Schedule, args.pluginConfigId)
    },
    runEveryHour: (hub, args: { pluginConfigId: number }) => {
        return runPluginTask(hub, 'runEveryHour', PluginTaskType.Schedule, args.pluginConfigId)
    },
    runEveryDay: (hub, args: { pluginConfigId: number }) => {
        return runPluginTask(hub, 'runEveryDay', PluginTaskType.Schedule, args.pluginConfigId)
    },
    getPluginSchedule: (hub) => {
        return hub.pluginSchedule
    },
    ingestEvent: async (hub, args: { event: PluginEvent }) => {
        return await ingestEvent(hub, args.event)
    },
    matchActions: async (hub, args: { event: PluginEvent }) => {
        return await hub.actionMatcher.match(args.event) // TODO: do something with action matching results
    },
    reloadPlugins: async (hub) => {
        await setupPlugins(hub)
    },
    reloadSchedule: async (hub) => {
        await loadSchedule(hub)
    },
    reloadAllActions: async (hub) => {
        return await hub.actionManager.reloadAllActions()
    },
    reloadAction: async (hub, args: { teamId: Team['id']; actionId: Action['id'] }) => {
        return await hub.actionManager.reloadAction(args.teamId, args.actionId)
    },
    dropAction: (hub, args: { teamId: Team['id']; actionId: Action['id'] }) => {
        return hub.actionManager.dropAction(args.teamId, args.actionId)
    },
    teardownPlugins: async (hub) => {
        await teardownPlugins(hub)
    },
    flushKafkaMessages: async (hub) => {
        await hub.kafkaProducer?.flush()
    },
}
