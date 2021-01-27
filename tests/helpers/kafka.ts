import { EventEmitter } from 'events'
import { Kafka, Consumer, logLevel, EachMessagePayload, Producer } from 'kafkajs'
import { KAFKA_EVENTS, KAFKA_EVENTS_INGESTION_HANDOFF } from '../../src/ingestion/topics'
import { parseRawEventMessage } from '../../src/ingestion/utils'
import { EventMessage } from '../../src/types'
import { UUIDT } from '../../src/utils'

export class KafkaObserver extends EventEmitter {
    public kafka: Kafka
    public producer: Producer
    public consumer: Consumer

    private isStarted: boolean

    constructor() {
        super()
        this.kafka = new Kafka({
            clientId: `plugin-server-test-${new UUIDT()}`,
            brokers: process.env.KAFKA_HOSTS!.split(','),
            logLevel: logLevel.NOTHING,
        })
        this.producer = this.kafka.producer()
        this.consumer = this.kafka.consumer({
            groupId: 'clickhouse-ingestion',
            readUncommitted: false,
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
            const { GROUP_JOIN, CRASH } = this.consumer.events
            this.consumer.on(GROUP_JOIN, () => resolve())
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

    public async waitForProcessedMessages(numberOfMessages: number): Promise<EventMessage[]> {
        return await new Promise<EventMessage[]>((resolve, reject) => {
            console.info('waiting for processed messages')
            const accumulator: EventMessage[] = []
            const timeoutSeconds = numberOfMessages * 2 // give every message 2 s on average to show up
            const rejectTimeout = setTimeout(
                () =>
                    reject(`Timed out waiting ${timeoutSeconds} seconds for ${numberOfMessages} message(s) from Kafka`),
                timeoutSeconds * 1000
            )
            const onMessage = (payload: EachMessagePayload) => {
                console.info('message received')
                accumulator.push(parseRawEventMessage(JSON.parse(payload.message.value!.toString())))
                if (accumulator.length >= numberOfMessages) {
                    this.removeListener('message', onMessage)
                    clearTimeout(rejectTimeout)
                    resolve(accumulator)
                }
            }
            this.addListener('message', onMessage)
        })
    }
}
