import { KafkaConsumer, LibrdKafkaError, Message, Producer, ProducerStream } from '@posthog/node-rdkafka'
import { DateTime } from 'luxon'
import * as Sentry from '@sentry/node'
import { PluginsServer, Properties, Queue, RawEventMessage } from 'types'
import { UUIDT } from '../utils'
import { KAFKA_EVENTS, KAFKA_EVENTS_WAL, KAFKA_SESSION_RECORDING_EVENTS } from './topics'
import { Pool } from 'pg'
import Piscina from 'piscina'
import { PluginEvent } from '@posthog/plugin-scaffold'

export type BatchCallback = (messages: Message[]) => Promise<void>

export class KafkaQueue implements Queue {
    private pluginsServer: PluginsServer
    private consumer: KafkaConsumer
    private consumptionInterval: NodeJS.Timeout | null
    private piscina: Piscina
    private batchCallback: BatchCallback
    isPaused: boolean

    constructor(pluginsServer: PluginsServer, piscina: Piscina) {
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
        this.piscina = piscina
        this.batchCallback = async () => console.error('batchCallback not set for KafkaQueue!')
        this.isPaused = false
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
            this.piscina.on('drain', () => {
                console.info('▶️ Piscina queue drained, Kafka consumption on play')
                this.isPaused = false
            })
            this.consumptionInterval = setInterval(() => {
                if (this.isPaused) {
                    return
                }
                this.consumer.consume(batchSize, (...args) => this.processBatchRaw(...args))
                if (this.piscina.queueSize >= this.piscina.options.maxQueue) {
                    console.info('⏸ Piscina queue full, Kafka consumption on pause')
                    this.isPaused = true
                }
            }, intervalMs)
        })
    }

    start(): void {
        console.info(`⏬ Connecting Kafka consumer to ${this.pluginsServer.KAFKA_HOSTS}...`)
        this.consumer.connect()
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
