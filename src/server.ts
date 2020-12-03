import { Pool } from 'pg'
import * as schedule from 'node-schedule'
import Redis from 'ioredis'
import { FastifyInstance } from 'fastify'
import { PluginsServer, PluginsServerConfig } from './types'
import { version } from '../package.json'
import { setupPlugins } from './plugins'
import { startWorker } from './worker'
import { startFastifyInstance, stopFastifyInstance } from './web/server'
import { piscina } from './server/piscina'

export const defaultConfig: PluginsServerConfig = {
    CELERY_DEFAULT_QUEUE: 'celery',
    DATABASE_URL: 'postgres://localhost:5432/posthog',
    PLUGINS_CELERY_QUEUE: 'posthog-plugins',
    REDIS_URL: 'redis://localhost/',
    BASE_DIR: '.',
    PLUGINS_RELOAD_PUBSUB_CHANNEL: 'reload-plugins',
    DISABLE_WEB: false,
    WEB_PORT: 3008,
    WEB_HOSTNAME: '0.0.0.0',
}

export async function startPluginsServer(config: PluginsServerConfig): Promise<void> {
    console.info(`⚡ Starting posthog-plugin-server v${version}…`)

    const serverConfig: PluginsServerConfig = {
        ...defaultConfig,
        ...config,
    }

    const db = new Pool({
        connectionString: serverConfig.DATABASE_URL,
    })

    const redis = new Redis(serverConfig.REDIS_URL)

    const server: PluginsServer = {
        ...serverConfig,
        db,
        redis,
    }

    // TODO: remove in next commits
    const result = await piscina.runTask({ task: 'hello', args: ['world'] })
    console.log(result) // Prints 'hello world'

    await setupPlugins(server)

    let fastifyInstance: FastifyInstance | null = null
    if (!serverConfig.DISABLE_WEB) {
        fastifyInstance = await startFastifyInstance(serverConfig.WEB_PORT, serverConfig.WEB_HOSTNAME)
    }

    let stopWorker = startWorker(server)

    const pubSub = new Redis(serverConfig.REDIS_URL)
    pubSub.subscribe(serverConfig.PLUGINS_RELOAD_PUBSUB_CHANNEL)
    pubSub.on('message', async (channel, message) => {
        if (channel === serverConfig.PLUGINS_RELOAD_PUBSUB_CHANNEL) {
            console.log('Reloading plugins!')
            await stopWorker()
            await setupPlugins(server)
            stopWorker = startWorker(server)
        }
    })

    // every 5 sec set a @posthog-plugin-server/ping redis key
    const job = schedule.scheduleJob('*/5 * * * * *', function () {
        redis.set('@posthog-plugin-server/ping', new Date().toISOString())
        redis.expire('@posthog-plugin-server/ping', 60)
    })
    console.info(`✅ Started posthog-plugin-server v${version}!`)

    const closeJobs = async () => {
        if (!serverConfig.DISABLE_WEB) {
            await stopFastifyInstance(fastifyInstance!)
        }
        await stopWorker()
        pubSub.disconnect()
        schedule.cancelJob(job)
        await redis.quit()
        await db.end()
    }

    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.on(signal, closeJobs)
    }
}
