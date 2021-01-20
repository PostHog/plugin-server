import * as Sentry from '@sentry/node'
import { Kafka, Consumer, Message } from 'kafkajs'
import { RawEventMessage, EventMessage, PluginsServer, Queue } from 'types'
import { KAFKA_EVENTS_INGESTION_HANDOFF } from './topics'
import { PluginEvent } from '@posthog/plugin-scaffold'
import { status } from '../status'
import { parseRawEventMessage } from './utils'

export type BatchCallback = (messages: Message[]) => Promise<void>

export class KafkaQueue implements Queue {
    private pluginsServer: PluginsServer
    private kafka: Kafka
    private consumer: Consumer
    private wasConsumerRan: boolean
    private processEventBatch: (batch: PluginEvent[]) => Promise<any>
    private saveEvent: (event: PluginEvent) => Promise<void>

    constructor(
        pluginsServer: PluginsServer,
        processEventBatch: (batch: PluginEvent[]) => Promise<any>,
        saveEvent: (event: PluginEvent) => Promise<void>
    ) {
        this.pluginsServer = pluginsServer
        this.kafka = pluginsServer.kafka!
        this.consumer = KafkaQueue.buildConsumer(this.kafka)
        this.wasConsumerRan = false
        this.processEventBatch = processEventBatch
        this.saveEvent = saveEvent
    }

    async start(): Promise<void> {
        const promise = new Promise<void>((resolve, reject) => {
            this.consumer.on(this.consumer.events.GROUP_JOIN, () => resolve())
            this.consumer.on(this.consumer.events.CRASH, ({ payload: { error } }) => reject(error))
        })
        status.info('⏬', `Connecting Kafka consumer to ${this.pluginsServer.KAFKA_HOSTS}...`)
        await this.consumer.subscribe({ topic: KAFKA_EVENTS_INGESTION_HANDOFF })
        // KafkaJS batching: https://kafka.js.org/docs/consuming#a-name-each-batch-a-eachbatch
        await this.consumer.run({
            // TODO: eachBatchAutoResolve: false, // don't autoresolve whole batch in case we exit it early
            // The issue is right now we'd miss some messages and not resolve them as processEventBatch COMPETELY
            // discards some events, leaving us with no kafka_offset to resolve when in fact it should be resolved.
            autoCommitInterval: 500, // autocommit every 500 ms…
            autoCommitThreshold: 1000, // …or every 1000 messages, whichever is sooner
            eachBatch: async ({
                batch,
                resolveOffset,
                heartbeat,
                commitOffsetsIfNecessary,
                uncommittedOffsets,
                isRunning,
                isStale,
            }) => {
                const rawEvents: RawEventMessage[] = batch.messages.map((message) => ({
                    ...JSON.parse(message.value!.toString()),
                    kafka_offset: message.offset,
                }))
                const parsedEvents = rawEvents.map(parseRawEventMessage)
                const pluginEvents: PluginEvent[] = parsedEvents.map((parsedEvent) => ({
                    ...parsedEvent,
                    now: parsedEvent.now.toISO(),
                    sent_at: parsedEvent.now.toISO(),
                    event: parsedEvent.data.event,
                    properties: parsedEvent.data.properties,
                }))
                const processedEvents: PluginEvent[] = (
                    await this.processEventBatch(pluginEvents)
                ).filter((event: PluginEvent[] | false | null | undefined) => Boolean(event))
                for (const event of processedEvents) {
                    if (!isRunning()) {
                        status.info('😮', 'Consumer not running anymore, canceling batch processing!')
                        return
                    }
                    if (isStale()) {
                        status.info('😮', 'Batch stale, canceling batch processing!')
                        return
                    }
                    await this.saveEvent(event)
                    resolveOffset(event.kafka_offset!)
                    await heartbeat()
                    await commitOffsetsIfNecessary()
                }
            },
        })
        this.wasConsumerRan = true
        return promise
    }

    async pause(): Promise<void> {
        if (!this.wasConsumerRan || this.isPaused()) {
            return
        }
        console.error('⏳ Pausing Kafka consumer...')
        await this.consumer.pause([{ topic: KAFKA_EVENTS_INGESTION_HANDOFF }])
        console.error('⏸ Kafka consumer paused!')
    }

    async resume(): Promise<void> {
        if (!this.wasConsumerRan || !this.isPaused()) {
            return
        }
        console.error('⏳ Resuming Kafka consumer...')
        await this.consumer.resume([{ topic: KAFKA_EVENTS_INGESTION_HANDOFF }])
        console.error('▶️ Kafka consumer resumed!')
    }

    isPaused(): boolean {
        return this.consumer.paused().some(({ topic }) => topic === KAFKA_EVENTS_INGESTION_HANDOFF)
    }

    async stop(): Promise<void> {
        try {
            status.info('⏳', 'Stopping Kafka queue...')
            await this.consumer.stop()
            status.error('⏹', 'Kafka consumer stopped!')
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
            status.error('⚠️', `Kafka consumer group ${groupId} crashed!`)
            console.error(error)
            Sentry.captureException(error)
            process.kill(process.pid, 'SIGINT')
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
