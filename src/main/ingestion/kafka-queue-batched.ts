import { PluginEvent } from '@posthog/plugin-scaffold'
import * as Sentry from '@sentry/node'
import { ConsumerRunConfig, EachBatchPayload } from 'kafkajs'

import { timeoutGuard } from '../../shared/ingestion/utils'
import { status } from '../../shared/status'
import { groupIntoBatches, sanitizeEvent } from '../../shared/utils'
import { KafkaQueueBase } from './kafka-queue-base'

export class KafkaQueueBatched extends KafkaQueueBase {
    protected getConsumerRunPayload(): ConsumerRunConfig {
        return {
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
        })

        const ingestOneEvent = async (event: PluginEvent) => {
            const singleIngestionTimeout = timeoutGuard('After 30 seconds still ingesting event', {
                event: JSON.stringify(event),
            })
            const singleIngestionTimer = new Date()
            try {
                await this.saveEvent(event)
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
}
