import { PluginEvent } from 'posthog-plugins'
import * as Sentry from '@sentry/node'
import { LibrdKafkaError, Message } from '@posthog/node-rdkafka'
import { DateTime } from 'luxon'
import Worker from '../celery/worker'
import Client from '../celery/client'
import { EventData, PluginsServer, Queue } from '../types'
import { EventsProcessor } from '../ingestion/process-event'
import { KAFKA_EVENTS_WAL } from '../ingestion/topics'

function startQueueRedis(
    server: PluginsServer,
    processEvent: (event: PluginEvent) => Promise<PluginEvent | null>
): Queue {
    const worker = new Worker(server.redis, server.PLUGINS_CELERY_QUEUE)
    const client = new Client(server.redis, server.CELERY_DEFAULT_QUEUE)

    worker.register(
        'posthog.tasks.process_event.process_event_with_plugins',
        async (
            distinct_id: string,
            ip: string,
            site_url: string,
            data: Record<string, unknown>,
            team_id: number,
            now: string,
            sent_at?: string
        ) => {
            const event = { distinct_id, ip, site_url, team_id, now, sent_at, ...data } as PluginEvent
            try {
                const processedEvent = await processEvent(event)
                if (processedEvent) {
                    const { distinct_id, ip, site_url, team_id, now, sent_at, ...data } = processedEvent
                    client.sendTask('posthog.tasks.process_event.process_event', [], {
                        distinct_id,
                        ip,
                        site_url,
                        data,
                        team_id,
                        now,
                        sent_at,
                    })
                }
            } catch (e) {
                Sentry.captureException(e)
            }
        }
    )

    worker.start()

    return worker
}

function startQueueKafka(
    server: PluginsServer,
    processEvent: (event: PluginEvent) => Promise<PluginEvent | null>
): Queue {
    const eventsProcessor = new EventsProcessor(server)
    eventsProcessor.connectKafkaConsumer()

    eventsProcessor.kafkaConsumer.on('ready', () => {
        console.info(`✅ Kafka consumer ready!`)
        eventsProcessor.kafkaConsumer.subscribe([KAFKA_EVENTS_WAL])
        // consume event messages in batches of 100
        eventsProcessor.kafkaConsumer.consume(
            100,
            async (error: LibrdKafkaError, messages: Message[]): Promise<void> => {
                if (error) {
                    Sentry.captureException(error)
                }
                try {
                    for (const message of messages) {
                        const timer = new Date()
                        const event = JSON.parse(message.value!.toString()) as EventData
                        const processedEvent = await processEvent(event)
                        if (processedEvent) {
                            const { distinct_id, ip, site_url, team_id, now, sent_at } = processedEvent
                            await eventsProcessor.process_event_ee(
                                distinct_id,
                                ip,
                                site_url,
                                processedEvent,
                                team_id,
                                DateTime.fromISO(now),
                                sent_at ? DateTime.fromISO(sent_at) : null
                            )
                        }
                        server.statsd?.timing(`${server.STATSD_PREFIX}_posthog_cloud`, timer)
                    }
                    eventsProcessor.kafkaConsumer.commit()
                } catch (error) {
                    Sentry.captureException(error)
                }
            }
        )
        console.info(`✅ Kafka consumer ready and subscribed to topic ${KAFKA_EVENTS_WAL}!`)
    })

    eventsProcessor.connectKafkaConsumer()

    return eventsProcessor
}

export function startQueue(
    server: PluginsServer,
    processEvent: (event: PluginEvent) => Promise<PluginEvent | null>
): Queue {
    const relevantStartQueue = server.EE_ENABLED ? startQueueKafka : startQueueRedis
    return relevantStartQueue(server, processEvent)
}
