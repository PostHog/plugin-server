import Piscina from '@posthog/piscina'
import * as schedule from 'node-schedule'

import { processError } from '../../shared/error'
import { status } from '../../shared/status'
import { delay } from '../../shared/utils'
import { PluginConfigId, PluginsServer, ScheduleControl } from '../../types'
import { startRedlock } from './redlock'

export const LOCKED_RESOURCE = 'plugin-server:locks:schedule'

export async function startSchedule(
    server: PluginsServer,
    piscina: Piscina,
    onLock?: () => void
): Promise<ScheduleControl> {
    status.info('⏰', 'Starting scheduling service...')

    let stopped = false
    let weHaveTheLock = false
    let pluginSchedulePromise = loadPluginSchedule(piscina)
    server.pluginSchedule = await pluginSchedulePromise

    const runEveryMinuteJob = schedule.scheduleJob('* * * * *', async () => {
        !stopped &&
            weHaveTheLock &&
            (await pluginSchedulePromise) &&
            runTasksDebounced(server!, piscina!, 'runEveryMinute')
    })
    const runEveryHourJob = schedule.scheduleJob('0 * * * *', async () => {
        !stopped &&
            weHaveTheLock &&
            (await pluginSchedulePromise) &&
            runTasksDebounced(server!, piscina!, 'runEveryHour')
    })
    const runEveryDayJob = schedule.scheduleJob('0 0 * * *', async () => {
        !stopped &&
            weHaveTheLock &&
            (await pluginSchedulePromise) &&
            runTasksDebounced(server!, piscina!, 'runEveryDay')
    })

    const unlock = await startRedlock(
        server,
        LOCKED_RESOURCE,
        () => {
            weHaveTheLock = true
        },
        () => {
            weHaveTheLock = false
        },
        server.SCHEDULE_LOCK_TTL
    )

    const stopSchedule = async () => {
        stopped = true
        runEveryDayJob && schedule.cancelJob(runEveryDayJob)
        runEveryHourJob && schedule.cancelJob(runEveryHourJob)
        runEveryMinuteJob && schedule.cancelJob(runEveryMinuteJob)

        await unlock()
        await waitForTasksToFinish(server!)
    }

    const reloadSchedule = async () => {
        pluginSchedulePromise = loadPluginSchedule(piscina)
        server.pluginSchedule = await pluginSchedulePromise
    }

    return { stopSchedule, reloadSchedule }
}

export async function loadPluginSchedule(
    piscina: Piscina,
    maxIterations = 2000
): Promise<PluginsServer['pluginSchedule']> {
    // :TRICKY: While loadSchedule is called during the worker init process, it sometimes does not finish executing
    //  due to threading shenanigans. Nudge the plugin server to finish loading!
    void piscina.broadcastTask({ task: 'reloadSchedule' })
    while (maxIterations--) {
        const schedule = (await piscina.runTask({ task: 'getPluginSchedule' })) as Record<
            string,
            PluginConfigId[]
        > | null
        if (schedule) {
            return schedule
        }
        await delay(200)
    }
    throw new Error('Could not load plugin schedule in time')
}

export function runTasksDebounced(server: PluginsServer, piscina: Piscina, taskName: string): void {
    const runTask = (pluginConfigId: PluginConfigId) => piscina.runTask({ task: taskName, args: { pluginConfigId } })

    for (const pluginConfigId of server.pluginSchedule?.[taskName] || []) {
        // last task still running? skip rerunning!
        if (server.pluginSchedulePromises[taskName][pluginConfigId]) {
            continue
        }

        const promise = runTask(pluginConfigId)
        server.pluginSchedulePromises[taskName][pluginConfigId] = promise

        promise
            .then(() => {
                server.pluginSchedulePromises[taskName][pluginConfigId] = null
            })
            .catch(async (error) => {
                await processError(server, pluginConfigId, error)
                server.pluginSchedulePromises[taskName][pluginConfigId] = null
            })
    }
}

export async function waitForTasksToFinish(server: PluginsServer): Promise<any[]> {
    const activePromises = Object.values(server.pluginSchedulePromises)
        .map(Object.values)
        .flat()
        .filter((a) => a)
    return Promise.all(activePromises)
}
