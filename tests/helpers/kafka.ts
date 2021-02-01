import { EventEmitter } from 'events'
import { Kafka, Consumer, logLevel, EachMessagePayload, Producer } from 'kafkajs'
import { KAFKA_EVENTS, KAFKA_EVENTS_INGESTION_HANDOFF } from '../../src/ingestion/topics'
import { parseRawEventMessage } from '../../src/ingestion/utils'
import { EventMessage, PluginsServerConfig } from '../../src/types'
import { delay, UUIDT } from '../../src/utils'
import { defaultConfig, overrideWithEnv } from '../../src/config'

export class KafkaObserver extends EventEmitter {
    public kafka: Kafka
    public producer: Producer
    public consumer: Consumer

    private isStarted: boolean

    constructor(extraServerConfig: Partial<PluginsServerConfig>) {
        super()
        const config = { ...overrideWithEnv(defaultConfig, process.env), ...extraServerConfig }
        this.kafka = new Kafka({
            clientId: `plugin-server-test-${new UUIDT()}`,
            brokers: (config.KAFKA_HOSTS || '').split(','),
            logLevel: logLevel.NOTHING,
        })
        this.producer = this.kafka.producer()
        this.consumer = this.kafka.consumer({
            groupId: 'clickhouse-ingestion-test',
        })
        this.isStarted = false
    }

    public async start(): Promise<void> {
        console.info('observer started!')
        if (this.isStarted) {
            return
        }
        this.isStarted = true
        return await new Promise<void>(async (resolve, reject) => {
            console.info('connecting producer')
            await this.producer.connect()
            console.info('subscribing consumer')
            await this.consumer.subscribe({ topic: KAFKA_EVENTS })
            console.info('running consumer')
            await this.consumer.run({
                eachMessage: async (payload) => {
                    console.info('message received!')
                    this.emit('message', payload)
                },
            })
            console.info('setting group join and crash listeners')
            const { CONNECT, GROUP_JOIN, CRASH } = this.consumer.events
            this.consumer.on(CONNECT, () => {
                console.log('consumer connected to kafka')
            })
            this.consumer.on(GROUP_JOIN, () => {
                console.log('joined group')
                resolve()
            })
            this.consumer.on(CRASH, ({ payload: { error } }) => reject(error))
        })
    }

    public async stop(): Promise<void> {
        this.removeAllListeners()
        console.info('disconnecting producer')
        await this.producer.disconnect()
        console.info('stopping consumer')
        await this.consumer.stop()
        console.info('disconnecting consumer')
        await this.consumer.disconnect()
    }

    public async handOffMessage(message: EventMessage): Promise<void> {
        console.info('producing message')
        await this.producer.send({
            topic: KAFKA_EVENTS_INGESTION_HANDOFF,
            messages: [{ value: Buffer.from(JSON.stringify(message)) }],
        })
    }
}

export class KafkaCollector extends EventEmitter {
    collection: EventMessage[]
    kafkaObserver: KafkaObserver

    constructor(kafkaObserver: KafkaObserver) {
        super()
        this.collection = []
        this.kafkaObserver = kafkaObserver
        kafkaObserver.addListener('message', (payload: EachMessagePayload) => {
            console.info('message received')
            this.collection.push(parseRawEventMessage(JSON.parse(payload.message.value!.toString())))
            this.emit('message')
        })
    }

    async collect(numberOfMessages: number): Promise<EventMessage[]> {
        return await new Promise((resolve) => {
            const resolveIfCollectedEnough = () => {
                console.log('collection:', this.collection)
                if (this.collection.length >= numberOfMessages) {
                    this.removeListener('message', resolveIfCollectedEnough)
                    resolve(this.collection)
                }
            }
            this.addListener('message', resolveIfCollectedEnough)
            resolveIfCollectedEnough()
        })
    }
}

/** Clear the kafka queue */
export async function resetKafka(extraServerConfig: Partial<PluginsServerConfig>, delayMs = 2000) {
    console.log('Resetting Kafka!')
    const config = { ...overrideWithEnv(defaultConfig, process.env), ...extraServerConfig }
    const kafka = new Kafka({
        clientId: `plugin-server-test-${new UUIDT()}`,
        brokers: (config.KAFKA_HOSTS || '').split(','),
        logLevel: logLevel.NOTHING,
    })
    const producer = kafka.producer()
    const consumer = kafka.consumer({
        groupId: 'clickhouse-ingestion-test',
    })
    const messages = []

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
        await consumer.subscribe({ topic: KAFKA_EVENTS_INGESTION_HANDOFF })
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
