import { fastify, FastifyInstance, FastifyPluginAsync } from 'fastify'
import { fastifyPostgres } from 'fastify-postgres'
import fastifyKafka from 'fastify-kafka'
import { PluginsServer } from 'types'
import { KAFKA_EVENTS_WAL } from './topics'
import { EventEmitter } from 'events'
import { EventsProcessor } from './process-event'

export const fastifyInstance = fastify()

export function buildFastifyInstance(pluginsServer: PluginsServer): FastifyInstance {
    fastifyInstance.register(fastifyPostgres, {
        connectionString: pluginsServer.DATABASE_URL,
    })
    if (pluginsServer.EE_ENABLED) {
        fastifyInstance.register(fastifyKafka as FastifyPluginAsync<fastifyKafka.FastifyKafkaOptions>, {
            producer: {
                dr_cb: true,
                'metadata.broker.list': pluginsServer.KAFKA_HOSTS,
            },
            consumer: {
                'metadata.broker.list': pluginsServer.KAFKA_HOSTS,
            },
            consumerTopicConf: {
                'auto.offset.reset': 'earliest',
            },
        })
        fastifyInstance.kafka.subscribe([KAFKA_EVENTS_WAL])
        const eventsProcessor = new EventsProcessor(pluginsServer)
        ;((fastifyInstance.kafka as unknown) as EventEmitter).on(
            KAFKA_EVENTS_WAL,
            eventsProcessor.processEventFromKafka
        )
    }
    return fastifyInstance
}

export async function stopFastifyInstance(fastifyInstance: FastifyInstance): Promise<void> {
    await fastifyInstance.close()
    console.info(`🛑 Web server cleaned up!`)
}

export async function startFastifyInstance(pluginsServer: PluginsServer): Promise<FastifyInstance> {
    console.info(`👾 Starting web server…`)
    const fastifyInstance = buildFastifyInstance(pluginsServer)
    try {
        const address = await fastifyInstance.listen(pluginsServer.WEB_PORT ?? 3008, pluginsServer.WEB_HOSTNAME)
        console.info(`✅ Web server listening on ${address}!`)
    } catch (e) {
        console.error(`🛑 Web server could not start! ${e}`)
        return fastifyInstance
    }
    return fastifyInstance
}
