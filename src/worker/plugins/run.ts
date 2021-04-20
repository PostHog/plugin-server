import { PluginEvent } from '@posthog/plugin-scaffold'

import { processError } from '../../shared/error'
import { posthog } from '../../shared/posthog'
import { PluginConfig, PluginsServer } from '../../types'

const EVENTS_TO_IGNORE = new Set(['$snapshot', '$plugin_running_duration'])

export async function runPlugins(server: PluginsServer, event: PluginEvent): Promise<PluginEvent | null> {
    if (EVENTS_TO_IGNORE.has(event.event)) {
        return event
    }
    const pluginsToRun = getPluginsForTeam(server, event.team_id)
    let returnedEvent: PluginEvent | null = event

    for (const pluginConfig of pluginsToRun) {
        const processEvent = await pluginConfig.vm?.getProcessEvent()

        if (processEvent) {
            const timer = new Date()

            try {
                returnedEvent = (await processEvent(returnedEvent)) || null
            } catch (error) {
                await processError(server, pluginConfig, error, returnedEvent)
                server.statsd?.increment(`plugin.${pluginConfig.plugin?.name}.process_event.ERROR`)
            }
            const timeSpentRunning = new Date().getTime() - timer.getTime()
            server.statsd?.timing(`plugin.${pluginConfig.plugin?.name}.process_event`, timer)
            posthog.capture('$plugin_running_duration', {
                team: event.team_id,
                plugin: pluginConfig.plugin?.name,
                time_ms: timeSpentRunning,
                time_seconds: Math.round(timeSpentRunning / 10) / 1000,
                function: 'processEvent',
            })
            if (!returnedEvent) {
                return null
            }
        }
    }

    return returnedEvent
}

export async function runPluginsOnBatch(server: PluginsServer, batch: PluginEvent[]): Promise<PluginEvent[]> {
    const eventsByTeam = new Map<number, PluginEvent[]>()

    for (const event of batch) {
        if (EVENTS_TO_IGNORE.has(event.event)) {
            continue
        }
        if (eventsByTeam.has(event.team_id)) {
            eventsByTeam.get(event.team_id)!.push(event)
        } else {
            eventsByTeam.set(event.team_id, [event])
        }
    }

    let allReturnedEvents: PluginEvent[] = []

    for (const [teamId, teamEvents] of eventsByTeam.entries()) {
        const pluginsToRun = getPluginsForTeam(server, teamId)

        let returnedEvents: PluginEvent[] = teamEvents

        for (const pluginConfig of pluginsToRun) {
            const timer = new Date()
            const processEventBatch = await pluginConfig.vm?.getProcessEventBatch()
            if (processEventBatch && returnedEvents.length > 0) {
                try {
                    returnedEvents = (await processEventBatch(returnedEvents)) || []
                } catch (error) {
                    await processError(server, pluginConfig, error, returnedEvents[0])
                    server.statsd?.increment(`plugin.${pluginConfig.plugin?.name}.process_event_batch.ERROR`)
                }
                const timeSpentRunning = new Date().getTime() - timer.getTime()
                server.statsd?.timing(`plugin.${pluginConfig.plugin?.name}.process_event_batch`, timer)
                server.statsd?.timing('plugin.process_event_batch', timer, 0.2, {
                    plugin: pluginConfig.plugin?.name ?? '?',
                    teamId: teamId.toString(),
                })
                posthog.capture('$plugin_running_duration', {
                    team: teamId,
                    plugin: pluginConfig.plugin?.name,
                    time_ms: timeSpentRunning,
                    time_seconds: Math.round(timeSpentRunning / 10) / 1000,
                    function: 'processEventBatch',
                })
            }
        }

        allReturnedEvents = allReturnedEvents.concat(returnedEvents)
    }

    return allReturnedEvents.filter(Boolean)
}

export async function runPluginTask(server: PluginsServer, taskName: string, pluginConfigId: number): Promise<any> {
    const timer = new Date()
    let response
    const pluginConfig = server.pluginConfigs.get(pluginConfigId)
    try {
        const task = await pluginConfig?.vm?.getTask(taskName)
        response = await task?.exec()
    } catch (error) {
        await processError(server, pluginConfigId, error)
        server.statsd?.increment(`plugin.task.${taskName}.${pluginConfigId}.ERROR`)
    }
    const timeSpentRunning = new Date().getTime() - timer.getTime()
    server.statsd?.timing(`plugin.task.${taskName}.${pluginConfigId}`, timer)
    posthog.capture('$plugin_running_duration', {
        team: pluginConfig?.team_id,
        plugin: pluginConfig?.plugin?.name,
        time_ms: timeSpentRunning,
        time_seconds: Math.round(timeSpentRunning / 10) / 1000,
        function: taskName,
    })
    return response
}

function getPluginsForTeam(server: PluginsServer, teamId: number): PluginConfig[] {
    return server.pluginConfigsPerTeam.get(teamId) || []
}
