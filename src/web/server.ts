import { fastify, FastifyInstance, FastifyPluginAsync, FastifyPluginCallback } from 'fastify'
import { fastifyPostgres } from 'fastify-postgres'
import fastifyKafka from 'fastify-kafka'
import { PluginsServerConfig } from 'types'
import { KAFKA_EVENTS_WAL } from './topics'
import { EventEmitter } from 'events'
import { processEventFromKafka } from './process-event'

export const fastifyInstance = fastify()

export function buildFastifyInstance({ DATABASE_URL, EE_ENABLED, KAFKA_HOSTS }: PluginsServerConfig): FastifyInstance {
    fastifyInstance.register(fastifyPostgres, {
        connectionString: DATABASE_URL,
    })
    if (EE_ENABLED) {
        fastifyInstance.register(fastifyKafka as FastifyPluginAsync<fastifyKafka.FastifyKafkaOptions>, {
            producer: {
                dr_cb: true,
                'metadata.broker.list': KAFKA_HOSTS,
            },
            consumer: {
                'metadata.broker.list': KAFKA_HOSTS,
            },
            consumerTopicConf: {
                'auto.offset.reset': 'earliest',
            },
        })
        fastifyInstance.kafka.subscribe([KAFKA_EVENTS_WAL])
        ;((fastifyInstance.kafka as unknown) as EventEmitter).on(KAFKA_EVENTS_WAL, processEventFromKafka)
    }
    return fastifyInstance
}

export async function stopFastifyInstance(fastifyInstance: FastifyInstance): Promise<void> {
    await fastifyInstance.close()
    console.info(`🛑 Web server cleaned up!`)
}

export async function startFastifyInstance(config: PluginsServerConfig): Promise<FastifyInstance> {
    console.info(`👾 Starting web server…`)
    const fastifyInstance = buildFastifyInstance(config)
    try {
        const address = await fastifyInstance.listen(config.WEB_PORT ?? 3008, config.WEB_HOSTNAME)
        console.info(`✅ Web server listening on ${address}!`)
    } catch (e) {
        console.error(`🛑 Web server could not start! ${e}`)
        return fastifyInstance
    }
    return fastifyInstance
}
