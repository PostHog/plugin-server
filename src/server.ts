import { Pool } from 'pg'
import * as schedule from 'node-schedule'
import Redis from 'ioredis'
import { FastifyInstance } from 'fastify'
import { PluginsServer, PluginsServerConfig } from './types'
import { startQueue } from './worker/queue'
import { startFastifyInstance, stopFastifyInstance } from './web/server'
import { Worker } from 'celery/worker'
import { version } from '../package.json'
import { PluginEvent } from 'posthog-plugins'
import Piscina from 'piscina'
import { StatsD } from 'hot-shots'
import { EventsProcessor } from './ingestion/process-event'

function overrideWithEnv(config: PluginsServerConfig): PluginsServerConfig {
    const newConfig: Record<string, any> = { ...config }
    for (const [key, value] of Object.entries(config)) {
        if (process.env[key]) {
            newConfig[key] = process.env[key]
        }
    }
    return newConfig as PluginsServerConfig
}

export const defaultConfig: PluginsServerConfig = overrideWithEnv({
    CELERY_DEFAULT_QUEUE: 'celery',
    DATABASE_URL: 'postgres://localhost:5432/posthog',
    PLUGINS_CELERY_QUEUE: 'posthog-plugins',
    REDIS_URL: 'redis://localhost/',
    BASE_DIR: '.',
    PLUGINS_RELOAD_PUBSUB_CHANNEL: 'reload-plugins',
    DISABLE_WEB: false,
    WEB_PORT: 3008,
    WEB_HOSTNAME: '0.0.0.0',
    WORKER_CONCURRENCY: 0, // use all cores
    STATSD_PORT: 8125,
    STATSD_PREFIX: '',
})

export async function createServer(
    config: Partial<PluginsServerConfig> = {}
): Promise<[PluginsServer, () => Promise<void>]> {
    const serverConfig: PluginsServerConfig = {
        ...defaultConfig,
        ...config,
    }

    const db = new Pool({
        connectionString: serverConfig.DATABASE_URL,
    })

    const redis = new Redis(serverConfig.REDIS_URL)

    const statsd = serverConfig.STATSD_HOST
        ? new StatsD({
              port: serverConfig.STATSD_PORT,
              host: serverConfig.STATSD_HOST,
          })
        : null

    const server: PluginsServer = {
        ...serverConfig,
        db,
        redis,
        statsd,
        plugins: new Map(),
        pluginConfigs: new Map(),
        pluginConfigsPerTeam: new Map(),
        defaultConfigs: [],
    }

    const closeServer = async () => {
        await server.redis.quit()
        await server.db.end()
    }

    return [server, closeServer]
}

export async function startPluginsServer(
    config: PluginsServerConfig,
    makePiscina: (config: PluginsServerConfig) => Piscina
): Promise<void> {
    console.info(`⚡ posthog-plugin-server v${version}`)

    let serverConfig: PluginsServerConfig | undefined
    let pubSub: Redis.Redis | undefined
    let server: PluginsServer | undefined
    let eventsProcessor: EventsProcessor | undefined
    let fastifyInstance: FastifyInstance | undefined
    let job: schedule.Job | undefined
    let piscina: Piscina | undefined
    let queue: Worker | undefined
    let closeServer: () => Promise<void> | undefined

    let shuttingDown = false

    async function closeJobs() {
        if (shuttingDown) {
            return
        }
        shuttingDown = true
        eventsProcessor?.stop()
        if (fastifyInstance && !serverConfig?.DISABLE_WEB) {
            await stopFastifyInstance(fastifyInstance!)
        }
        await queue?.stop()
        pubSub?.disconnect()
        if (job) {
            schedule.cancelJob(job)
        }
        await piscina?.destroy()
        await closeServer()
    }

    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.on(signal, closeJobs)
    }

    try {
        serverConfig = {
            ...defaultConfig,
            ...config,
        }
        ;[server, closeServer] = await createServer(serverConfig)

        piscina = makePiscina(serverConfig)
        const processEvent = (event: PluginEvent) => piscina!.runTask({ task: 'processEvent', args: { event } })

        if (serverConfig.EE_ENABLED) {
            eventsProcessor = new EventsProcessor(server)
            eventsProcessor.connectKafkaConsumer()
        }

        if (!serverConfig.DISABLE_WEB) {
            fastifyInstance = await startFastifyInstance(server)
        }

        queue = startQueue(server, processEvent)

        pubSub = new Redis(server.REDIS_URL)
        pubSub.subscribe(server.PLUGINS_RELOAD_PUBSUB_CHANNEL)
        pubSub.on('message', async (channel: string, message) => {
            if (channel === server!.PLUGINS_RELOAD_PUBSUB_CHANNEL) {
                console.log('⚡ Reloading plugins!')
                await queue?.stop()
                await piscina?.destroy()

                piscina = makePiscina(config)
                queue = startQueue(server!, processEvent)
            }
        })

        // every 5 sec set a @posthog-plugin-server/ping redis key
        job = schedule.scheduleJob('*/5 * * * * *', () => {
            server!.redis!.set('@posthog-plugin-server/ping', new Date().toISOString())
            server!.redis!.expire('@posthog-plugin-server/ping', 60)
        })
        console.info(`🚀 All systems go.`)
    } catch (error) {
        console.error(`💥 Launchpad failure!\n${error.stack}`)
        await closeJobs()
        process.exit(1)
    }
}
