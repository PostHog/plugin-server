import { Kafka, logLevel } from 'kafkajs'
import { PluginsServerConfig } from '../../src/types'
import { delay, UUIDT } from '../../src/utils'
import { defaultConfig, overrideWithEnv } from '../../src/config'
import { KAFKA_EVENTS_PLUGIN_INGESTION, KAFKA_SESSION_RECORDING_EVENTS } from '../../src/ingestion/topics'

/** Clear the kafka queue */
export async function resetKafka(extraServerConfig: Partial<PluginsServerConfig>, delayMs = 2000) {
    console.log('Resetting Kafka!')
    const config = { ...overrideWithEnv(defaultConfig, process.env), ...extraServerConfig }
    const kafka = new Kafka({
        clientId: `plugin-server-test-${new UUIDT()}`,
        brokers: (config.KAFKA_HOSTS || '').split(','),
        logLevel: logLevel.WARN,
    })
    const producer = kafka.producer()
    const consumer = kafka.consumer({
        groupId: 'clickhouse-ingestion-test',
    })
    const messages = []

    async function createTopic(topic: string) {
        try {
            const admin = kafka.admin()
            await admin.connect()
            await admin.createTopics({
                waitForLeaders: true,
                topics: [{ topic }],
            })
            await admin.disconnect()
        } catch (e) {
            if (!e?.error?.includes('Topic with this name already exists')) {
                console.error(`Error creating kafka topic "${topic}". This might be fine!`)
                console.error(e)
            }
        }
    }

    await createTopic(KAFKA_EVENTS_PLUGIN_INGESTION)
    await createTopic(KAFKA_SESSION_RECORDING_EVENTS)

    const connected = await new Promise<void>(async (resolve, reject) => {
        console.info('setting group join and crash listeners')
        const { CONNECT, GROUP_JOIN, CRASH } = consumer.events
        consumer.on(CONNECT, () => {
            console.log('consumer connected to kafka')
        })
        consumer.on(GROUP_JOIN, () => {
            console.log('joined group')
            resolve()
        })
        consumer.on(CRASH, ({ payload: { error } }) => reject(error))
        console.info('connecting producer')
        await producer.connect()
        console.info('subscribing consumer')

        await consumer.subscribe({ topic: KAFKA_EVENTS_PLUGIN_INGESTION })
        console.info('running consumer')
        await consumer.run({
            eachMessage: async (payload) => {
                console.info('message received!')
                messages.push(payload)
            },
        })
    })

    console.info(`awaiting ${delayMs} ms before disconnecting`)
    await delay(delayMs)

    console.info('disconnecting producer')
    await producer.disconnect()
    console.info('stopping consumer')
    await consumer.stop()
    console.info('disconnecting consumer')
    await consumer.disconnect()

    return true
}
