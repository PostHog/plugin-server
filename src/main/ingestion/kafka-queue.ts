import Piscina from '@posthog/piscina'
import { PluginEvent } from '@posthog/plugin-scaffold'
import * as Sentry from '@sentry/node'
import { Consumer, EachBatchPayload, EachMessagePayload, Kafka } from 'kafkajs'
import { PluginsServer, Queue } from 'types'

import { timeoutGuard } from '../../shared/ingestion/utils'
import { status } from '../../shared/status'
import { getPiscinaStats, groupIntoBatches, killGracefully, sanitizeEvent } from '../../shared/utils'

export class KafkaQueue implements Queue {
    private pluginsServer: PluginsServer
    private piscina: Piscina
    private kafka: Kafka
    private consumer: Consumer
    private wasConsumerRan: boolean
    private processEvent: (event: PluginEvent) => Promise<PluginEvent>
    private processEventBatch: (batch: PluginEvent[]) => Promise<PluginEvent[]>
    private ingestEvent: (event: PluginEvent) => Promise<void>

    // used for logging aggregate stats to the console
    private messageLogDate = 0
    private messageCounter = 0

    constructor(
        pluginsServer: PluginsServer,
        piscina: Piscina,
        processEvent: (event: PluginEvent) => Promise<any>,
        processEventBatch: (batch: PluginEvent[]) => Promise<any>,
        ingestEvent: (event: PluginEvent) => Promise<void>
    ) {
        this.pluginsServer = pluginsServer
        this.piscina = piscina
        this.kafka = pluginsServer.kafka!
        this.consumer = KafkaQueue.buildConsumer(this.kafka)
        this.wasConsumerRan = false
        this.processEvent = processEvent
        this.processEventBatch = processEventBatch
        this.ingestEvent = ingestEvent
        this.messageLogDate = new Date().valueOf()
    }

    private async eachMessage({ topic, partition, message }: EachMessagePayload): Promise<void> {
        const eachMessageStartTimer = new Date()

        const { data: dataStr, ...rawEvent } = JSON.parse(message.value!.toString())
        const combinedEvent = { ...rawEvent, ...JSON.parse(dataStr) }
        const event = sanitizeEvent({
            ...combinedEvent,
            site_url: combinedEvent.site_url || null,
            ip: combinedEvent.ip || null,
        })

        const processingTimeout = timeoutGuard('Still running plugins on event. Timeout warning after 30 sec!', {
            event: JSON.stringify(event),
        })
        const timer = new Date()
        let processedEvent: PluginEvent
        try {
            processedEvent = await this.processEvent(event)
        } catch (error) {
            status.info('🔔', error)
            Sentry.captureException(error)
            throw error
        } finally {
            this.pluginsServer.statsd?.timing('kafka_queue.single_event_batch', timer)
            this.pluginsServer.statsd?.timing('kafka_queue.each_batch.process_events', timer)
            clearTimeout(processingTimeout)
        }

        // ingest event

        if (processedEvent) {
            const singleIngestionTimeout = timeoutGuard('After 30 seconds still ingesting event', {
                event: JSON.stringify(processedEvent),
                piscina: JSON.stringify(getPiscinaStats(this.piscina)),
            })
            const singleIngestionTimer = new Date()
            try {
                await this.ingestEvent(processedEvent)
            } catch (error) {
                status.info('🔔', error)
                Sentry.captureException(error)
                throw error
            } finally {
                this.pluginsServer.statsd?.timing('kafka_queue.single_ingestion', singleIngestionTimer)
                this.pluginsServer.statsd?.timing('kafka_queue.each_batch.ingest_events', singleIngestionTimer)
                clearTimeout(singleIngestionTimeout)
            }
        }

        this.pluginsServer.statsd?.timing('kafka_queue.each_batch', eachMessageStartTimer)

        const now = new Date().valueOf()
        this.messageCounter++
        if (now - this.messageLogDate > 10000) {
            status.info(
                '🕒',
                `Processed ${this.messageCounter} events in ${Math.round((now - this.messageLogDate) / 10) / 100}s`
            )
            this.messageCounter = 0
            this.messageLogDate = now
        }
    }

    private async eachBatch({
        batch,
        resolveOffset,
        heartbeat,
        commitOffsetsIfNecessary,
        isRunning,
        isStale,
    }: EachBatchPayload): Promise<void> {
        const batchStartTimer = new Date()

        const uuidOrder = new Map<string, number>()
        const uuidOffset = new Map<string, string>()
        const pluginEvents: PluginEvent[] = batch.messages.map((message, index) => {
            const { data: dataStr, ...rawEvent } = JSON.parse(message.value!.toString())
            const event = { ...rawEvent, ...JSON.parse(dataStr) }
            uuidOrder.set(event.uuid, index)
            uuidOffset.set(event.uuid, message.offset)
            return sanitizeEvent({
                ...event,
                site_url: event.site_url || null,
                ip: event.ip || null,
            })
        })

        const maxBatchSize = Math.max(
            15,
            Math.min(
                100,
                Math.ceil(
                    pluginEvents.length / this.pluginsServer.WORKER_CONCURRENCY / this.pluginsServer.TASKS_PER_WORKER
                )
            )
        )

        const processingTimeout = timeoutGuard('Still running plugins on events. Timeout warning after 30 sec!', {
            eventCount: pluginEvents.length,
            piscina: JSON.stringify(getPiscinaStats(this.piscina)),
        })
        const processingBatches = groupIntoBatches(pluginEvents, maxBatchSize)
        const processedEvents = (
            await Promise.all(
                processingBatches.map(async (batch) => {
                    const timer = new Date()
                    const processedBatch = this.processEventBatch(batch)
                    this.pluginsServer.statsd?.timing('kafka_queue.single_event_batch', timer)
                    return processedBatch
                })
            )
        ).flat()

        clearTimeout(processingTimeout)

        this.pluginsServer.statsd?.timing('kafka_queue.each_batch.process_events', batchStartTimer)
        const batchIngestionTimer = new Date()

        // Sort in the original order that the events came in, putting any randomly added events to the end.
        // This is so we would resolve the correct kafka offsets in order.
        processedEvents.sort(
            (a, b) => (uuidOrder.get(a.uuid!) || pluginEvents.length) - (uuidOrder.get(b.uuid!) || pluginEvents.length)
        )

        const ingestionTimeout = timeoutGuard('Still ingesting events. Timeout warning after 30 sec!', {
            eventCount: processedEvents.length,
            piscina: JSON.stringify(getPiscinaStats(this.piscina)),
        })

        const ingestOneEvent = async (event: PluginEvent) => {
            const singleIngestionTimeout = timeoutGuard('After 30 seconds still ingesting event', {
                event: JSON.stringify(event),
                piscina: JSON.stringify(getPiscinaStats(this.piscina)),
            })
            const singleIngestionTimer = new Date()
            try {
                await this.ingestEvent(event)
            } catch (error) {
                status.info('🔔', error)
                Sentry.captureException(error)
                throw error
            } finally {
                this.pluginsServer.statsd?.timing('kafka_queue.single_ingestion', singleIngestionTimer)
                clearTimeout(singleIngestionTimeout)
            }
        }
        const maxIngestionBatch = Math.max(
            this.pluginsServer.WORKER_CONCURRENCY * this.pluginsServer.TASKS_PER_WORKER,
            50
        )
        const ingestionBatches = groupIntoBatches(processedEvents, maxIngestionBatch)
        for (const batch of ingestionBatches) {
            await Promise.all(batch.map(ingestOneEvent))
            const offset = uuidOffset.get(batch[batch.length - 1].uuid!)
            if (offset) {
                resolveOffset(offset)
            }
            await commitOffsetsIfNecessary()
        }

        clearTimeout(ingestionTimeout)

        this.pluginsServer.statsd?.timing('kafka_queue.each_batch.ingest_events', batchIngestionTimer)
        this.pluginsServer.statsd?.timing('kafka_queue.each_batch', batchStartTimer)

        status.info(
            '🧩',
            `Kafka batch of ${pluginEvents.length} events completed in ${
                new Date().valueOf() - batchStartTimer.valueOf()
            }ms (plugins: ${batchIngestionTimer.valueOf() - batchStartTimer.valueOf()}ms, ingestion: ${
                new Date().valueOf() - batchIngestionTimer.valueOf()
            }ms)`
        )

        resolveOffset(batch.lastOffset())
        await commitOffsetsIfNecessary()
        await heartbeat()
    }

    async start(): Promise<void> {
        const startPromise = new Promise<void>(async (resolve, reject) => {
            this.consumer.on(this.consumer.events.GROUP_JOIN, () => resolve())
            this.consumer.on(this.consumer.events.CRASH, ({ payload: { error } }) => reject(error))
            status.info('⏬', `Connecting Kafka consumer to ${this.pluginsServer.KAFKA_HOSTS}...`)
            this.wasConsumerRan = true
            await this.consumer.subscribe({ topic: this.pluginsServer.KAFKA_CONSUMPTION_TOPIC! })
            if (this.pluginsServer.USE_KAFKA_EACH_MESSAGE) {
                await this.consumer.run({
                    partitionsConsumedConcurrently:
                        this.pluginsServer.WORKER_CONCURRENCY * this.pluginsServer.TASKS_PER_WORKER,
                    autoCommitInterval: 500, // autocommit every 500 ms…
                    autoCommitThreshold: 1000, // …or every 1000 messages, whichever is sooner
                    eachMessage: async (payload) => {
                        try {
                            await this.eachMessage(payload)
                        } catch (error) {
                            status.info('💀', `Kafka message failed: ${payload.message.value?.toString()}`)
                            status.info('🔔', error)
                            Sentry.captureException(error)
                            throw error
                        }
                    },
                })
            } else {
                // KafkaJS batching: https://kafka.js.org/docs/consuming#a-name-each-batch-a-eachbatch
                await this.consumer.run({
                    eachBatchAutoResolve: false, // we are resolving the last offset of the batch more deliberately
                    autoCommitInterval: 500, // autocommit every 500 ms…
                    autoCommitThreshold: 1000, // …or every 1000 messages, whichever is sooner
                    eachBatch: async (payload) => {
                        try {
                            await this.eachBatch(payload)
                        } catch (error) {
                            status.info('💀', `Kafka batch of ${payload.batch.messages.length} events failed!`)
                            Sentry.captureException(error)
                            throw error
                        }
                    },
                })
            }
        })
        return await startPromise
    }

    async pause(): Promise<void> {
        if (this.wasConsumerRan && !this.isPaused()) {
            status.info('⏳', 'Pausing Kafka consumer...')
            this.consumer.pause([{ topic: this.pluginsServer.KAFKA_CONSUMPTION_TOPIC! }])
            status.info('⏸', 'Kafka consumer paused!')
        }
        return Promise.resolve()
    }

    resume(): void {
        if (this.wasConsumerRan && this.isPaused()) {
            status.info('⏳', 'Resuming Kafka consumer...')
            this.consumer.resume([{ topic: this.pluginsServer.KAFKA_CONSUMPTION_TOPIC! }])
            status.info('▶️', 'Kafka consumer resumed!')
        }
    }

    isPaused(): boolean {
        return this.consumer.paused().some(({ topic }) => topic === this.pluginsServer.KAFKA_CONSUMPTION_TOPIC)
    }

    async stop(): Promise<void> {
        status.info('⏳', 'Stopping Kafka queue...')
        try {
            await this.consumer.stop()
            status.info('⏹', 'Kafka consumer stopped!')
        } catch (error) {
            status.error('⚠️', 'An error occurred while stopping Kafka queue:\n', error)
        }
        try {
            await this.consumer.disconnect()
        } catch {}
    }

    private static buildConsumer(kafka: Kafka): Consumer {
        const consumer = kafka.consumer({
            groupId: 'clickhouse-ingestion',
            readUncommitted: false,
        })
        const { GROUP_JOIN, CRASH, CONNECT, DISCONNECT } = consumer.events
        consumer.on(GROUP_JOIN, ({ payload: { groupId } }) => {
            status.info('✅', `Kafka consumer joined group ${groupId}!`)
        })
        consumer.on(CRASH, ({ payload: { error, groupId } }) => {
            status.error('⚠️', `Kafka consumer group ${groupId} crashed:\n`, error)
            Sentry.captureException(error)
            killGracefully()
        })
        consumer.on(CONNECT, () => {
            status.info('✅', 'Kafka consumer connected!')
        })
        consumer.on(DISCONNECT, () => {
            status.info('🛑', 'Kafka consumer disconnected!')
        })
        return consumer
    }
}
