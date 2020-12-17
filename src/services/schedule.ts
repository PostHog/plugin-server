import { PluginConfigId, PluginsServer } from '../types'
import Piscina from 'piscina'
import { processError } from '../error'
import * as schedule from 'node-schedule'

export async function startSchedule(server: PluginsServer, piscina: Piscina): Promise<() => Promise<void>> {
    console.info(`⏰ Starting scheduling service`)

    server.pluginSchedule = await piscina.runTask({ task: 'getPluginSchedule' })

    const runEveryMinuteJob = schedule.scheduleJob('* * * * *', () => {
        runTasksDebounced(server!, piscina!, 'runEveryMinute')
    })
    const runEveryHourJob = schedule.scheduleJob('0 * * * *', () => {
        runTasksDebounced(server!, piscina!, 'runEveryHour')
    })
    const runEveryDayJob = schedule.scheduleJob('0 0 * * *', () => {
        runTasksDebounced(server!, piscina!, 'runEveryDay')
    })

    return async () => {
        runEveryDayJob && schedule.cancelJob(runEveryDayJob)
        runEveryHourJob && schedule.cancelJob(runEveryHourJob)
        runEveryMinuteJob && schedule.cancelJob(runEveryMinuteJob)

        await waitForTasksToFinish(server!)
    }
}

export function runTasksDebounced(server: PluginsServer, piscina: Piscina, taskName: string): void {
    const runTask = (pluginConfigId: PluginConfigId) => piscina.runTask({ task: taskName, args: { pluginConfigId } })

    for (const pluginConfigId of server.pluginSchedule[taskName]) {
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
