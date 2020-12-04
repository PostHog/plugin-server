import { runPlugins, setupPlugins } from '../plugins'
import { createServer } from '../server'
import { PluginsServerConfig } from '../types'

export async function createWorker(config: PluginsServerConfig) {
    const [server, closeServer] = await createServer(config)
    await setupPlugins(server)

    const closeJobs = async () => {
        await closeServer()
    }
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.on(signal, closeJobs)
    }

    return async ({ task, args }: { task: string; args: any }): Promise<any> => {
        if (task === 'hello') {
            return `hello ${args[0]}!`
        }
        if (task === 'processEvent') {
            return await runPlugins(server, args.event)
        }
    }
}
