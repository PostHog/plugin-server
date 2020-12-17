import { PluginConfigId, PluginsServer } from '../types'
import Piscina from 'piscina'
import { processError } from '../error'
import * as schedule from 'node-schedule'
import Redlock from 'redlock'
import * as Sentry from '@sentry/node'

const lockedResource = 'plugin-server:locks:schedule'

export async function startSchedule(
    server: PluginsServer,
    piscina: Piscina,
    onLock?: () => void
): Promise<() => Promise<void>> {
    console.info(`⏰ Starting scheduling service`)

    let stopped = false
    let weHaveTheLock = false
    let lock: Redlock.Lock
    let lockExtender: NodeJS.Timeout

    const lockTTL = server.SCHEDULE_LOCK_TTL * 1000
    const redlock = new Redlock([server.redis], {
        driftFactor: 0.01, // multiplied by lock ttl to determine drift time
        retryCount: -1, // retry forever
        retryDelay: lockTTL / 10, // time in ms
        retryJitter: lockTTL / 30, // time in ms
    })
    redlock.on('clientError', (error) => {
        console.error('RedLock clientError', error)
        Sentry.captureException(error)
    })

    const tryToGetTheLock = () => {
        redlock
            .lock(lockedResource, lockTTL)
            .then((acquiredLock) => {
                if (stopped) {
                    return
                }
                console.info(`🔒 Scheduler lock acquired!`)
                weHaveTheLock = true
                lock = acquiredLock

                lockExtender = setInterval(async () => {
                    if (stopped) {
                        return
                    }
                    try {
                        lock = await lock.extend(lockTTL)
                    } catch (error) {
                        console.error('RedLock can not extend lock!', error)
                        Sentry.captureException(error)
                        clearInterval(lockExtender)
                        weHaveTheLock = false
                        setTimeout(tryToGetTheLock, 0)
                    }
                }, lockTTL / 2)

                onLock?.()
            })
            .catch((err) => {
                Sentry.captureException(err)
                console.error(err)
            })
    }

    tryToGetTheLock()

    server.pluginSchedule = await piscina.runTask({ task: 'getPluginSchedule' })

    const runEveryMinuteJob = schedule.scheduleJob('* * * * *', () => {
        !stopped && weHaveTheLock && runTasksDebounced(server!, piscina!, 'runEveryMinute')
    })
    const runEveryHourJob = schedule.scheduleJob('0 * * * *', () => {
        !stopped && weHaveTheLock && runTasksDebounced(server!, piscina!, 'runEveryHour')
    })
    const runEveryDayJob = schedule.scheduleJob('0 0 * * *', () => {
        !stopped && weHaveTheLock && runTasksDebounced(server!, piscina!, 'runEveryDay')
    })

    const stopSchedule = async () => {
        stopped = true
        lockExtender && clearInterval(lockExtender)
        runEveryDayJob && schedule.cancelJob(runEveryDayJob)
        runEveryHourJob && schedule.cancelJob(runEveryHourJob)
        runEveryMinuteJob && schedule.cancelJob(runEveryMinuteJob)

        await lock?.unlock().catch(Sentry.captureException)
        await waitForTasksToFinish(server!)
    }

    return stopSchedule
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
