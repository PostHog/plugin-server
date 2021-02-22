import { ingestEvent } from '../ingestion/ingest-event'
import { initApp } from '../init'
import { runPlugins, runPluginsOnBatch, runPluginTask, setupPlugins } from '../plugins'
import { createServer } from '../server'
import { status } from '../status'
import { PluginsServerConfig } from '../types'
import { cloneObject } from '../utils'

type TaskWorker = ({ task, args }: { task: string; args: any }) => Promise<any>

export async function createWorker(config: PluginsServerConfig, threadId: number): Promise<TaskWorker> {
    initApp(config)

    status.info('🧵', `Starting Piscina worker thread ${threadId}…`)

    const [server, closeServer] = await createServer(config, threadId)
    await setupPlugins(server)

    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.on(signal, closeServer)
    }

    return async ({ task, args }) => {
        const timer = new Date()
        let response

        if (task === 'hello') {
            response = `hello ${args[0]}!`
        }
        if (task === 'processEvent') {
            const processedEvent = await runPlugins(server, args.event)
            // must clone the object, as we may get from VM2 something like { ..., properties: Proxy {} }
            response = cloneObject(processedEvent as Record<string, any>)
        }
        if (task === 'processEventBatch') {
            const processedEvents = await runPluginsOnBatch(server, args.batch)
            // must clone the object, as we may get from VM2 something like { ..., properties: Proxy {} }
            response = cloneObject(processedEvents as any[])
        }
        if (task === 'getPluginSchedule') {
            response = cloneObject(server.pluginSchedule)
        }
        if (task === 'ingestEvent') {
            response = cloneObject(await ingestEvent(server, args.event))
        }
        if (task.startsWith('runEvery')) {
            const { pluginConfigId } = args
            response = cloneObject(await runPluginTask(server, task, pluginConfigId))
        }
        server.statsd?.timing(`piscina_task.${task}`, timer)
        return response
    }
}
