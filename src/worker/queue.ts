import { PluginEvent } from 'posthog-plugins'
import * as Sentry from '@sentry/node'
import { LibrdKafkaError, Message } from '@posthog/node-rdkafka'
import { DateTime } from 'luxon'
import Worker from '../celery/worker'
import Client from '../celery/client'
import { ParsedEventMessage, PluginsServer, Queue, RawEventMessage } from '../types'
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

    eventsProcessor.kafkaConsumer.on('ready', () => {
        eventsProcessor.kafkaConsumer.subscribe([KAFKA_EVENTS_WAL])
        // consume event messages in batches of 1000 every 50 ms
        const consumptionInterval = setInterval(() => {
            eventsProcessor.kafkaConsumer.consume(
                1000,
                async (error: LibrdKafkaError, messages: Message[]): Promise<void> => {
                    if (error) {
                        console.error('⚠️ Error while consuming!')
                        console.error(error)
                        Sentry.captureException(error)
                    }
                    if (messages?.length) {
                        console.info(
                            `🍕 ${Date.now()} ${messages.length} ${
                                messages.length === 1 ? 'message' : 'messages'
                            } consumed from Kafka`
                        )
                    } else {
                        return
                    }
                    try {
                        for (const message of messages) {
                            const timer = new Date()
                            const rawEventMessage = JSON.parse(message.value!.toString()) as RawEventMessage
                            const parsedEventMessage: ParsedEventMessage = {
                                ...rawEventMessage,
                                data: JSON.parse(rawEventMessage.data),
                                now: DateTime.fromISO(rawEventMessage.now),
                                sent_at: rawEventMessage.sent_at ? DateTime.fromISO(rawEventMessage.sent_at) : null,
                            }
                            console.info(`Processing event ${parsedEventMessage.data.event} from WAL`)
                            const processedEvent = await processEvent({
                                ...parsedEventMessage,
                                event: parsedEventMessage.data.event,
                                properties: parsedEventMessage.data.properties,
                                now: rawEventMessage.now,
                                sent_at: rawEventMessage.sent_at,
                            })
                            if (processedEvent) {
                                console.info(`Ingesting event ${parsedEventMessage.data.event}`)
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
                                console.info(`Ingested event ${parsedEventMessage.data.event}!`)
                            } else {
                                console.info(`Discarding event ${parsedEventMessage.data.event}`)
                            }
                            server.statsd?.timing(`${server.STATSD_PREFIX}_posthog_cloud`, timer)
                        }
                        eventsProcessor.kafkaConsumer.commit()
                    } catch (error) {
                        console.error('⚠️ Error while processing batch of event messages!')
                        console.error(error)
                        Sentry.captureException(error)
                    }
                }
            )
        }, 50)
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
            process.on(signal, () => clearInterval(consumptionInterval))
        }
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
