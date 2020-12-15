import { KafkaConsumer, LibrdKafkaError, Message, Producer, ProducerStream } from '@posthog/node-rdkafka'
import { DateTime } from 'luxon'
import * as Sentry from '@sentry/node'
import { PluginsServer, EventData, Properties, Queue } from 'types'
import { UUIDT } from '../utils'
import { KAFKA_EVENTS, KAFKA_EVENTS_WAL, KAFKA_SESSION_RECORDING_EVENTS } from './topics'
import { Pool } from 'pg'

export class EventsProcessor implements Queue {
    pluginsServer: PluginsServer
    db: Pool
    kafkaConsumer: KafkaConsumer
    consumptionInterval: NodeJS.Timeout | null
    batchCallback: (messages: Message[]) => Promise<void>

    constructor(
        pluginsServer: PluginsServer,
        batchSize: number,
        intervalMs: number,
        batchCallback: (messages: Message[]) => Promise<void>
    ) {
        if (!pluginsServer.KAFKA_HOSTS) {
            throw new Error('You must set KAFKA_HOSTS to process events from Kafka!')
        }
        this.pluginsServer = pluginsServer
        this.db = pluginsServer.db
        this.kafkaConsumer = new KafkaConsumer(
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
                console.info(
                    `📌 Kafka consumer commited offset ${topicPartitions
                        .map((entry) => `${entry.offset} for topic ${entry.topic} (parition ${entry.partition})`)
                        .join(', ')}!`
                )
            })
            .on('subscribed', (topics) => {
                console.info(`✅ Kafka consumer subscribed to topic ${topics.map(String).join(' and ')}!`)
            })
            .on('unsubscribed', () => {
                console.info(`🔌 Kafka consumer unsubscribed from topics!`)
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
            .on('ready', () => {
                console.info(`✅ Kafka consumer ready!`)
                this.kafkaConsumer.subscribe([KAFKA_EVENTS_WAL])
                // consume event messages in batches of 1000 every 50 ms
                this.consumptionInterval = setInterval(() => {
                    this.kafkaConsumer.consume(batchSize, (...args) => this.processBatchRaw(...args))
                }, intervalMs)
            })
            .on('disconnected', () => {
                console.info(`🛑 Kafka consumer disconnected!`)
            })
        this.consumptionInterval = null
        this.batchCallback = batchCallback
    }

    processBatchRaw(error: LibrdKafkaError, messages: Message[]): void {
        if (error) {
            console.error('⚠️ Kafka consumption error inside callback!')
            console.error(error)
            Sentry.captureException(error)
        }
        if (messages?.length) {
            console.info(
                `🍕 ${messages.length} ${
                    messages.length === 1 ? 'message' : 'messages'
                } consumed from Kafka at ${Date.now()}`
            )
        } else {
            return
        }
        try {
            this.batchCallback(messages)
            this.kafkaConsumer.commit()
        } catch (error) {
            console.error('⚠️ Error while processing batch of event messages!')
            console.error(error)
            Sentry.captureException(error)
        }
    }

    start(): void {
        console.info(`⏬ Connecting Kafka consumer to ${this.pluginsServer.KAFKA_HOSTS}...`)
        this.kafkaConsumer.connect()
    }

    stop(): void {
        console.info(`⏳ Stopping event processing...`)
        this.kafkaConsumer.unsubscribe()
        this.kafkaConsumer.disconnect()
        this.kafkaConsumer.emit('disconnected')
        if (this.consumptionInterval) {
            clearInterval(this.consumptionInterval)
        }
    }

    async process_event_ee(
        distinct_id: string,
        ip: string,
        site_url: string,
        data: EventData,
        team_id: number,
        now: DateTime,
        sent_at: DateTime | null
    ): Promise<void> {
        const properties: Properties = data.properties ?? {}
        if (data['$set']) {
            properties['$set'] = data['$set']
        }

        const person_uuid = new UUIDT()
        const event_uuid = new UUIDT()

        // No-op currently
    }
}
