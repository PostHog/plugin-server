import { KafkaConsumer, LibrdKafkaError, Message } from '@posthog/node-rdkafka'
import * as Sentry from '@sentry/node'
import { PluginsServer, Queue } from 'types'
import { KAFKA_EVENTS_WAL } from './topics'

export type BatchCallback = (messages: Message[]) => Promise<void>

export class KafkaQueue implements Queue {
    private pluginsServer: PluginsServer
    private consumer: KafkaConsumer
    private consumptionInterval: NodeJS.Timeout | null
    private batchCallback: BatchCallback
    private isPausedState: boolean

    constructor(pluginsServer: PluginsServer) {
        if (!pluginsServer.KAFKA_HOSTS) {
            throw new Error('You must set KAFKA_HOSTS to process events from Kafka!')
        }
        this.pluginsServer = pluginsServer
        this.consumer = new KafkaConsumer(
            {
                'group.id': 'plugin-ingestion',
                'metadata.broker.list': this.pluginsServer.KAFKA_HOSTS!,
                'enable.auto.commit': false,
            },
            {
                'auto.offset.reset': 'earliest',
            }
        )
            .on('offset.commit', (error, topicPartitions) => {
                if (error) {
                    console.error('⚠️ Kafka consumer offset commit error!')
                    console.error(error)
                    Sentry.captureException(error)
                } else {
                    console.info(
                        `📌 Kafka consumer commited offset ${topicPartitions
                            .map((entry) => `${entry.offset} for topic ${entry.topic} (parition ${entry.partition})`)
                            .join(', ')}!`
                    )
                }
            })
            .on('subscribed', (topics) => {
                console.info(`✅ Kafka consumer subscribed to topic ${topics.map(String).join(' and ')}!`)
            })
            .on('unsubscribed', () => {
                console.info(`🔌 Kafka consumer unsubscribed from all topics!`)
            })
            .on('connection.failure', (error) => {
                console.error('⚠️ Kafka consumer connection failure!')
                console.error(error)
                Sentry.captureException(error)
            })
            .on('rebalance.error', (error) => {
                console.error('⚠️ Kafka consumer rebalancing error!')
                console.error(error)
                Sentry.captureException(error)
            })
            .on('event.error', (error) => {
                console.error('⚠️ Kafka consumer event error!')
                console.error(error)
                Sentry.captureException(error)
            })
            .on('disconnected', () => {
                console.info(`🛑 Kafka consumer disconnected!`)
            })
        this.consumptionInterval = null
        this.batchCallback = async () => console.error('batchCallback not set for KafkaQueue!')
        this.isPausedState = false
    }

    processBatchRaw(error: LibrdKafkaError, messages: Message[]): void {
        if (error) {
            console.error('⚠️ Kafka consumption error inside callback!')
            console.error(error)
            Sentry.captureException(error)
        }
        try {
            this.batchCallback(messages)
            this.consumer.commit()
        } catch (error) {
            console.error('⚠️ Error while processing batch of event messages!')
            console.error(error)
            Sentry.captureException(error)
        }
    }

    consume(batchSize: number, intervalMs: number, batchCallback: BatchCallback): void {
        this.batchCallback = batchCallback
        this.consumer.on('ready', () => {
            console.info(`✅ Kafka consumer ready!`)
            this.consumer.subscribe([KAFKA_EVENTS_WAL])
            this.consumptionInterval = setInterval(() => {
                if (this.isPausedState) {
                    return
                }
                this.consumer.consume(batchSize, (...args) => this.processBatchRaw(...args))
            }, intervalMs)
        })
    }

    start(): void {
        console.info(`⏬ Connecting Kafka consumer to ${this.pluginsServer.KAFKA_HOSTS}...`)
        this.consumer.connect()
    }

    async pause(): Promise<void> {
        this.isPausedState = true
    }

    resume(): void {
        this.isPausedState = false
    }

    isPaused(): boolean {
        return this.isPausedState
    }

    stop(): void {
        console.info(`⏳ Stopping event processing...`)
        this.consumer.unsubscribe()
        this.consumer.disconnect()
        if (this.consumptionInterval) {
            clearInterval(this.consumptionInterval)
        }
    }
}
