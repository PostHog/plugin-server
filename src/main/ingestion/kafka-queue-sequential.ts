import * as Sentry from '@sentry/node'
import { ConsumerRunConfig, EachMessagePayload } from 'kafkajs'

import { timeoutGuard } from '../../shared/ingestion/utils'
import { status } from '../../shared/status'
import { sanitizeEvent } from '../../shared/utils'
import { KafkaQueueBase } from './kafka-queue-base'

export class KafkaQueueSequential extends KafkaQueueBase {
    protected getConsumerRunPayload(): ConsumerRunConfig {
        return {
            autoCommitInterval: 500, // autocommit every 500 ms…
            autoCommitThreshold: 1000, // …or every 1000 messages, whichever is sooner
            eachMessage: async (payload) => {
                try {
                    await this.eachMessage(payload)
                } catch (error) {
                    status.info('💀', `Kafka message failed!`)
                    Sentry.captureException(error)
                    throw error
                }
            },
        }
    }

    private async eachMessage({ message }: EachMessagePayload): Promise<void> {
        const messageStartTimer = new Date()
        const { data: dataStr, ...rawEvent } = JSON.parse(message.value!.toString())
        const eventTemp = { ...rawEvent, ...JSON.parse(dataStr) }
        const eventToProcess = sanitizeEvent({
            ...eventTemp,
            site_url: eventTemp.site_url || null,
            ip: eventTemp.ip || null,
        })

        const processingTimeout = timeoutGuard('Still running plugins on one event. Timeout warning after 30 sec!')

        const timer = new Date()
        const processedEvent = await this.processEvent(eventToProcess)
        this.pluginsServer.statsd?.timing('kafka_queue.single_event_batch', timer)
        this.pluginsServer.statsd?.timing('kafka_queue.each_batch.process_events', timer)

        clearTimeout(processingTimeout)

        const batchIngestionTimer = new Date()
        const ingestionTimeout = timeoutGuard('Still ingesting one event. Timeout warning after 30 sec!')

        const singleIngestionTimeout = timeoutGuard('After 30 seconds still ingesting event', {
            event: JSON.stringify(processedEvent),
        })
        const singleIngestionTimer = new Date()
        try {
            await this.saveEvent(processedEvent)
        } catch (error) {
            status.info('🔔', error)
            Sentry.captureException(error)
            throw error
        } finally {
            this.pluginsServer.statsd?.timing('kafka_queue.single_ingestion', singleIngestionTimer)
            clearTimeout(singleIngestionTimeout)
        }

        clearTimeout(ingestionTimeout)

        this.pluginsServer.statsd?.timing('kafka_queue.each_batch.ingest_events', batchIngestionTimer)
        this.pluginsServer.statsd?.timing('kafka_queue.each_batch', messageStartTimer)

        status.info(
            '🧩',
            `Kafka one events completed in ${new Date().valueOf() - messageStartTimer.valueOf()}ms (plugins: ${
                batchIngestionTimer.valueOf() - messageStartTimer.valueOf()
            }ms, ingestion: ${new Date().valueOf() - batchIngestionTimer.valueOf()}ms)`
        )
    }
}
