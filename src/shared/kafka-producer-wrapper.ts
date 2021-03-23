import { StatsD } from 'hot-shots'
import { Producer, ProducerRecord } from 'kafkajs'

import { PluginsServerConfig } from '../types'
import { timeoutGuard } from './ingestion/utils'
import { instrumentQuery } from './metrics'

export class KafkaProducerWrapper {
    /** Kafka producer used for syncing Postgres and ClickHouse person data. */
    producer: Producer
    /** StatsD instance used to do instrumentation */
    statsd: StatsD | undefined

    lastFlushTime: number
    currentBatch: Array<ProducerRecord>
    currentBatchSize: number

    flushFrequencyMs: number
    maxQueueSize: number
    maxBatchSize: number

    flushInterval: NodeJS.Timeout

    constructor(producer: Producer, statsd: StatsD | undefined, serverConfig: PluginsServerConfig) {
        this.producer = producer
        this.statsd = statsd

        this.lastFlushTime = Date.now()
        this.currentBatch = []
        this.currentBatchSize = 0

        this.flushFrequencyMs = serverConfig.KAFKA_FLUSH_FREQUENCY_MS
        this.maxQueueSize = serverConfig.KAFKA_PRODUCER_MAX_QUEUE_SIZE
        this.maxBatchSize = serverConfig.KAFKA_MAX_MESSAGE_BATCH_SIZE

        this.flushInterval = setInterval(() => this.flush(), this.flushFrequencyMs)
    }

    async queueMessage(kafkaMessage: ProducerRecord): Promise<void> {
        const messageSize = this.getMessageSize(kafkaMessage)

        if (this.currentBatchSize + messageSize > this.maxBatchSize) {
            await this.flush(kafkaMessage)
        } else {
            this.currentBatch.push(kafkaMessage)
            this.currentBatchSize += messageSize

            const timeSinceLastFlush = Date.now() - this.lastFlushTime
            if (timeSinceLastFlush > this.flushFrequencyMs || this.currentBatch.length >= this.maxQueueSize) {
                await this.flush()
            }
        }
    }

    public flush(append?: ProducerRecord): Promise<void> {
        if (this.currentBatch.length === 0) {
            return Promise.resolve()
        }

        return instrumentQuery(this.statsd, 'query.kafka_send', undefined, async () => {
            const messages = this.currentBatch
            this.lastFlushTime = Date.now()
            this.currentBatch = append ? [append] : []
            this.currentBatchSize = append ? this.getMessageSize(append) : 0

            const timeout = timeoutGuard('Kafka message sending delayed. Waiting over 30 sec to send messages.')
            try {
                await this.producer.sendBatch({
                    topicMessages: messages,
                })
            } finally {
                clearTimeout(timeout)
            }
        })
    }

    private getMessageSize(kafkaMessage: ProducerRecord): number {
        return kafkaMessage.messages
            .map((message) => {
                if (message.value === null) {
                    return 4
                }
                if (!Buffer.isBuffer(message.value)) {
                    message.value = Buffer.from(message.value)
                }
                return message.value.length
            })
            .reduce((a, b) => a + b)
    }
}
