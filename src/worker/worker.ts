import { runPlugins, runPluginsOnBatch, runPluginTask, setupPlugins } from '../plugins'
import { cloneObject } from '../utils'
import { createServer } from '../server'
import { PluginsServerConfig } from '../types'
import { initApp } from '../init'
import { status } from '../status'

type TaskWorker = ({ task, args }: { task: string; args: any }) => Promise<any>

export async function createWorker(config: PluginsServerConfig, threadId: number): Promise<TaskWorker> {
    initApp(config)

    status.info('🧵', `Starting Piscina worker thread ${threadId}…`)

    const [server, closeServer] = await createServer(config, threadId)
    await setupPlugins(server)

    const closeJobs = async () => {
        await closeServer()
    }
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.on(signal, closeJobs)
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
        if (task.startsWith('runEvery')) {
            const { pluginConfigId } = args
            response = cloneObject(await runPluginTask(server, task, pluginConfigId))
        }
        server.statsd?.timing(`piscina_task.${task}`, timer)
        return response
    }
}
