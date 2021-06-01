import Piscina from '@posthog/piscina'
import { PluginEvent } from '@posthog/plugin-scaffold'
import * as Sentry from '@sentry/node'

import { Hub, WorkerMethods } from '../../types'
import { timeoutGuard } from '../../utils/db/utils'
import { status } from '../../utils/status'

export async function installPlugin(
    server: Hub,
    piscina: Piscina,
    plugin_id: number,
    team_id: number,
    plugin_installation_id: number,
    // TODO: convert this trifecta into an object.
    // .. Wait, will PluginConfig suffice for this? Config manages which installation to use?
    checkAndPause?: () => void // pause incoming messages if we are slow in getting them out again
): Promise<void> {
    const eachEventStartTimer = new Date()

    function sendInstallTask(plugin_id: number, team_id: number, plugin_installation_id: number) {
        return piscina.runTask({ task: 'installPlugin', args: { plugin_id, team_id, plugin_installation_id } })
    }

    checkAndPause?.()

    // TODO: leaving things here for now, but next steps:
    /*
        1. Installation id as part of pluginConfig
        2. setup new piscina pool to be used here for installPlugin task
        3. Trickle down, fix everything on those "test_worker"s
        4. Trickle back up, figure out how to send results back via Celery
            4.1: consider making the queue separate, if very different things
        5. Do the Django Tango
    */
    response = await runInstrumentedFunction({
        server,
        event,
        func: (plugin_id, team_id, plugin_installation_id) =>
            sendInstallTask(plugin_id, team_id, plugin_installation_id),
        statsKey: 'install_queue.single_plugin',
        timeoutMessage: 'Still installing plugin. Timeout warning after 30 sec!',
    })

    checkAndPause?.()

    server.statsd?.timing('kafka_queue.each_event', eachEventStartTimer)
    server.internalMetrics?.incr('$$plugin_server_events_processed')
}

async function runInstrumentedFunction({
    server,
    timeoutMessage,
    event,
    func,
    statsKey,
}: {
    server: Hub
    event: PluginEvent
    timeoutMessage: string
    statsKey: string
    func: (event: PluginEvent) => Promise<any>
}): Promise<any> {
    const timeout = timeoutGuard(timeoutMessage, {
        event: JSON.stringify(event),
    })
    const timer = new Date()
    try {
        return await func(event)
    } catch (error) {
        status.info('🔔', error)
        Sentry.captureException(error)
        throw error
    } finally {
        server.statsd?.timing(statsKey, timer)
        clearTimeout(timeout)
    }
}
