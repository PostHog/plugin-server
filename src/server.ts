import { Pool } from 'pg'
import * as schedule from 'node-schedule'
import Redis from 'ioredis'
import { FastifyInstance } from 'fastify'
import { PluginsServer, PluginsServerConfig } from './types'
import { startQueue } from './worker/queue'
import { startFastifyInstance, stopFastifyInstance } from './web/server'
import { version } from '../package.json'
import { makePiscina } from './worker/piscina'
import { PluginEvent } from 'posthog-plugins'

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

export async function createServer(config: PluginsServerConfig): Promise<[PluginsServer, () => Promise<void>]> {
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

    const closeServer = async () => {
        await server.redis.quit()
        await server.db.end()
    }

    return [server, closeServer]
}

export async function startPluginsServer(config: PluginsServerConfig): Promise<void> {
    console.info(`⚡ Starting posthog-plugin-server v${version}…`)

    const [server, closeServer] = await createServer(config)

    let piscina = makePiscina(config)
    const processEvent = (event: PluginEvent) => piscina.runTask({ task: 'processEvent', args: { event } })

    let fastifyInstance: FastifyInstance | null = null
    if (!server.DISABLE_WEB) {
        fastifyInstance = await startFastifyInstance(server.WEB_PORT, server.WEB_HOSTNAME)
    }

    let stopQueue = startQueue(server, processEvent)

    const pubSub = new Redis(server.REDIS_URL)
    pubSub.subscribe(server.PLUGINS_RELOAD_PUBSUB_CHANNEL)
    pubSub.on('message', async (channel, message) => {
        if (channel === server.PLUGINS_RELOAD_PUBSUB_CHANNEL) {
            console.log('Reloading plugins! NOT IMPLEMENTED FOR MULTITHREADING!')
            await stopQueue()
            await piscina.destroy()

            piscina = makePiscina(config)
            stopQueue = startQueue(server, processEvent)
        }
    })

    // every 5 sec set a @posthog-plugin-server/ping redis key
    const job = schedule.scheduleJob('*/5 * * * * *', function () {
        server.redis.set('@posthog-plugin-server/ping', new Date().toISOString())
        server.redis.expire('@posthog-plugin-server/ping', 60)
    })
    console.info(`✅ Started posthog-plugin-server v${version}!`)

    const closeJobs = async () => {
        pubSub.disconnect()
        schedule.cancelJob(job)

        if (!server.DISABLE_WEB) {
            await stopFastifyInstance(fastifyInstance!)
        }
        await stopQueue()
        await piscina.destroy()
        await closeServer()
    }

    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.on(signal, closeJobs)
    }
}
