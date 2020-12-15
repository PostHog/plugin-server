import { PluginEvent } from '@posthog/plugin-scaffold'
import * as Sentry from '@sentry/node'
import { LibrdKafkaError, Message } from '@posthog/node-rdkafka'
import { DateTime } from 'luxon'
import Worker from '../celery/worker'
import Client from '../celery/client'
import { ParsedEventMessage, PluginsServer, Queue, RawEventMessage } from '../types'
import { EventsProcessor } from '../ingestion/process-event'
import { KAFKA_EVENTS_WAL } from '../ingestion/topics'
import { KafkaQueue } from '../ingestion/kafka-queue'
import Piscina from 'piscina'

export function startQueue(
    server: PluginsServer,
    processEvent: (event: PluginEvent) => Promise<PluginEvent | null>,
    processEventBatch: (event: PluginEvent[]) => Promise<(PluginEvent | null)[]>,
    piscina?: Piscina
): Queue {
    const relevantStartQueue = server.EE_ENABLED ? startQueueKafka : startQueueRedis
    return relevantStartQueue(server, processEvent, processEventBatch, piscina!)
}

function startQueueRedis(
    server: PluginsServer,
    processEvent: (event: PluginEvent) => Promise<PluginEvent | null>,
    processEventBatch: (event: PluginEvent[]) => Promise<(PluginEvent | null)[]>,
    piscina?: Piscina
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
    processEvent: (event: PluginEvent) => Promise<PluginEvent | null>,
    processEventBatch: (event: PluginEvent[]) => Promise<(PluginEvent | null)[]>,
    piscina: Piscina
): Queue {
    const eventsProcessor = new EventsProcessor(server)
    const kafkaQueue = new KafkaQueue(server, 1000, 50, piscina, async (messages) => {
        const batchProcessingTimer = new Date()
        const processableEvents: PluginEvent[] = messages.map((message) => {
            const rawEventMessage = JSON.parse(message.value!.toString()) as RawEventMessage
            const data = JSON.parse(rawEventMessage.data)
            return {
                ...rawEventMessage,
                data,
                event: data.event,
                properties: data.properties,
            }
        })
        const processedEvents = (await processEventBatch(processableEvents)).filter((event) =>
            Boolean(event)
        ) as PluginEvent[]
        for (const event of processedEvents) {
            const singleIngestionTimer = new Date()
            console.info(`Ingesting event ${event.event}`)
            const { distinct_id, ip, site_url, team_id, now, sent_at } = event
            await eventsProcessor.process_event_ee(
                distinct_id,
                ip,
                site_url,
                event,
                team_id,
                DateTime.fromISO(now),
                sent_at ? DateTime.fromISO(sent_at) : null
            )
            console.info(`Ingested event ${event.event}!`)
            server.statsd?.timing('single-ingestion', singleIngestionTimer)
        }
        server.statsd?.timing('batch-processing', batchProcessingTimer)
    })

    kafkaQueue.start()

    return kafkaQueue
}
