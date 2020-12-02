import { fastify, FastifyInstance, FastifyPluginAsync, FastifyPluginCallback } from 'fastify'
import { fastifyPostgres } from 'fastify-postgres'
import fastifyKafka from 'fastify-kafka'

export interface FastifySettings {
    DATABASE_URL: string // Postgres database URL
    KAFKA_HOSTS: string
}

export function buildFastifyInstance({ DATABASE_URL, KAFKA_HOSTS }: FastifySettings): FastifyInstance {
    const fastifyInstance = fastify()
    fastifyInstance.register(fastifyPostgres, {
        connectionString: DATABASE_URL,
    })
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
    return fastifyInstance
}

export async function stopFastifyInstance(fastifyInstance: FastifyInstance): Promise<void> {
    await fastifyInstance.close()
    console.info(`🛑 Web server cleaned up!`)
}

export async function startFastifyInstance(
    port: string | number = 3008,
    hostname?: string,
    withSignalHandling = true
): Promise<FastifyInstance> {
    console.info(`👾 Starting web server…`)
    const fastifyInstance = buildFastifyInstance()
    try {
        const address = await fastifyInstance.listen(port, hostname)
        console.info(`✅ Web server listening on ${address}!`)
    } catch (e) {
        console.error(`🛑 Web server could not start! ${e}`)
        return fastifyInstance
    }
    return fastifyInstance
}
