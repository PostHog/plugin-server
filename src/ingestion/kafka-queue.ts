import * as Sentry from '@sentry/node'
import { Kafka, Consumer, Message, EachBatchPayload } from 'kafkajs'
import { EventMessage, PluginsServer, Queue, RawEventMessage } from 'types'
import { KAFKA_EVENTS_INGESTION_HANDOFF } from './topics'
import { PluginEvent } from '@posthog/plugin-scaffold'
import { status } from '../status'
import { killGracefully } from '../utils'
import { parseRawEventMessage } from './utils'

export type BatchCallback = (messages: Message[]) => Promise<void>

/**
 * We use this to avoid a situation where the event was discarded and because of that its Kafka offset is not resolved,
 * potentially causing unnecessary message retries.
 *
 * Works in the following way: for each event UUID the algorithm sets the Kafka offset to resolve
 * based on the last event after it from the Kafka topic that WAS discarded. Example, we've got events:
 * ```JS
 * [{ uuid: 'a', offset: 1 }, { uuid: 's', offset: 2 }, { uuid: 'd', offset: 3 }, { uuid: 'f', offset: 4 }]
 * ```
 * Now some plugin discards the last two! Returned map for use in resolveOffset() will in result look like this:
 * ```JS
 * { 'a': 1, 's': 4, 'd': 4, 'f': 4 }
 * ```
 * Because 'd' and 'f' were discarded by a plugin, when we save 's' to the database, we'll know that at the same time
 * we in fact also covered 'd' and 'f' and should resolve the last offset - belonging to 'f' – not an intermediary one.
 * As for 'a', we simply resolve its offset outright, because its next event ('s') is not discarded.
 */
function aliasEventUuidForDiscardedKafkaOffsets(
    rawEventMessages: RawEventMessage[],
    processedEvents: PluginEvent[]
): Map<string, string> {
    rawEventMessages = [...rawEventMessages] // Shallow copy to avoid side effects
    const eventUuidToKafkaOffset = new Map<string, string>()
    const processedUuids: Set<string> = new Set(processedEvents.map((event) => event.uuid!))
    rawEventMessages.reverse()
    // This initial value below is in fact the last message, due to the array being reversed
    let nextOffsetNotDiscarded: string | null = rawEventMessages.shift()!.kafka_offset
    for (const rawEventMessage of rawEventMessages) {
        if (processedUuids.has(rawEventMessage.uuid)) {
            nextOffsetNotDiscarded = rawEventMessage.kafka_offset
        }
        eventUuidToKafkaOffset.set(rawEventMessage.uuid, nextOffsetNotDiscarded)
    }
    return eventUuidToKafkaOffset
}

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

    private async eachBatch({
        batch,
        resolveOffset,
        heartbeat,
        commitOffsetsIfNecessary,
        isRunning,
        isStale,
    }: EachBatchPayload): Promise<void> {
        const batchProcessingTimer = new Date()
        const rawEventMessages: RawEventMessage[] = batch.messages.map((message) => ({
            ...JSON.parse(message.value!.toString()),
            kafka_offset: message.offset,
        }))
        const parsedEventMessages: EventMessage[] = rawEventMessages.map(parseRawEventMessage)
        const pluginEvents: PluginEvent[] = rawEventMessages.map((rawEventMessage) => {
            const { data: dataString, kafka_offset: kafkaOffset, ...restOfRawEventMessage } = rawEventMessage
            const event = { ...restOfRawEventMessage, ...JSON.parse(dataString) }
            return {
                ...event,
                site_url: event.site_url || null,
                ip: event.ip || null,
            }
        })
        const processedEvents: PluginEvent[] = (
            await this.processEventBatch(pluginEvents)
        ).filter((event: PluginEvent[] | false | null | undefined) => Boolean(event))
        if (processedEvents.length) {
            const eventUuidToKafkaOffset = aliasEventUuidForDiscardedKafkaOffsets(rawEventMessages, processedEvents)
            for (const event of processedEvents) {
                if (!isRunning()) {
                    status.info('😮', 'Consumer not running anymore, canceling batch processing!')
                    return
                }
                if (isStale()) {
                    status.info('😮', 'Batch stale, canceling batch processing!')
                    return
                }
                const singleIngestionTimer = new Date()
                await this.saveEvent(event)
                resolveOffset(eventUuidToKafkaOffset.get(event.uuid!)!)
                await heartbeat()
                await commitOffsetsIfNecessary()
                this.pluginsServer.statsd?.timing('kafka_queue.single_ingestion', singleIngestionTimer)
            }
        } else {
            // If all events were discarded in plugin processing, just resolve the final offset and do nothing else
            resolveOffset(rawEventMessages[rawEventMessages.length - 1].kafka_offset)
            await heartbeat()
            await commitOffsetsIfNecessary()
        }
        this.pluginsServer.statsd?.timing('kafka_queue.each_batch', batchProcessingTimer)
    }

    async start(): Promise<void> {
        const startPromise = new Promise<void>(async (resolve, reject) => {
            this.consumer.on(this.consumer.events.GROUP_JOIN, () => resolve())
            this.consumer.on(this.consumer.events.CRASH, ({ payload: { error } }) => reject(error))
            status.info('⏬', `Connecting Kafka consumer to ${this.pluginsServer.KAFKA_HOSTS}...`)
            this.wasConsumerRan = true
            await this.consumer.subscribe({ topic: KAFKA_EVENTS_INGESTION_HANDOFF })
            // KafkaJS batching: https://kafka.js.org/docs/consuming#a-name-each-batch-a-eachbatch
            await this.consumer.run({
                // TODO: eachBatchAutoResolve: false, // don't autoresolve whole batch in case we exit it early
                // The issue is right now we'd miss some messages and not resolve them as processEventBatch COMPETELY
                // discards some events, leaving us with no kafka_offset to resolve when in fact it should be resolved.
                autoCommitInterval: 500, // autocommit every 500 ms…
                autoCommitThreshold: 1000, // …or every 1000 messages, whichever is sooner
                eachBatch: this.eachBatch.bind(this),
            })
        })
        return await startPromise
    }

    async pause(): Promise<void> {
        if (!this.wasConsumerRan || this.isPaused()) {
            return
        }
        status.info('⏳', 'Pausing Kafka consumer...')
        await this.consumer.pause([{ topic: KAFKA_EVENTS_INGESTION_HANDOFF }])
        status.info('⏸', 'Kafka consumer paused!')
    }

    async resume(): Promise<void> {
        if (!this.wasConsumerRan || !this.isPaused()) {
            return
        }
        status.info('⏳', 'Resuming Kafka consumer...')
        await this.consumer.resume([{ topic: KAFKA_EVENTS_INGESTION_HANDOFF }])
        status.info('▶️', 'Kafka consumer resumed!')
    }

    isPaused(): boolean {
        return this.consumer.paused().some(({ topic }) => topic === KAFKA_EVENTS_INGESTION_HANDOFF)
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
