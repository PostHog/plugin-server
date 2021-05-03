import { PluginConfig, PluginsServer } from '../../../types'

type Job = (payload?: any) => Promise<void>
type Jobs = Record<string, Job>
type JobRunner = {
    runIn: (duration: number, unit: string) => Jobs
    runNow: () => Jobs
}

const milliseconds = 1
const seconds = 1000 * milliseconds
const minutes = 60 * seconds
const hours = 60 * minutes
const days = 24 * hours
const weeks = 7 * days
const months = 30 * weeks
const quarters = 13 * weeks
const years = 365 * days
const durations: Record<string, number> = {
    milliseconds,
    seconds,
    minutes,
    hours,
    days,
    weeks,
    months,
    quarters,
    years,
}

export function durationToMs(duration: number, unit: string): number {
    unit = `${unit}${unit.endsWith('s') ? '' : 's'}`
    if (typeof durations[unit] === 'undefined') {
        throw new Error(`Unknown time unit: ${unit}`)
    }
    return durations[unit] * duration
}

export function createJobs(server: PluginsServer, pluginConfig: PluginConfig): JobRunner {
    const runJob = async (type: string, payload: Record<string, any>, timestamp: number) => {
        await server.jobQueueManager.enqueue({
            type,
            payload,
            timestamp,
            pluginConfigId: pluginConfig.id,
            pluginConfigTeam: pluginConfig.team_id,
        })
    }

    return {
        runIn: (duration, unit) => {
            return new Proxy(
                {},
                {
                    get: (target, key) => async (payload: Record<string, any>) => {
                        const timestamp = new Date().valueOf() + durationToMs(duration, unit)
                        await runJob(key.toString(), payload, timestamp)
                    },
                }
            )
        },
        runNow: () => {
            return new Proxy(
                {},
                {
                    get: (target, key) => async (payload: Record<string, any>) => {
                        await runJob(key.toString(), payload, new Date().valueOf())
                    },
                }
            )
        },
    }
}
