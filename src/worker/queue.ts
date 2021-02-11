import { PluginEvent } from '@posthog/plugin-scaffold'
import * as Sentry from '@sentry/node'
import Piscina from 'piscina'

import Client from '../celery/client'
import Worker from '../celery/worker'
import { IngestEventResponse } from '../ingestion/ingest-event'
import { KafkaQueue } from '../ingestion/kafka-queue'
import { status } from '../status'
import { PluginsServer, Queue } from '../types'

export type WorkerMethods = {
    processEvent: (queue: Queue, event: PluginEvent) => Promise<PluginEvent | null>
    processEventBatch: (queue: Queue, event: PluginEvent[]) => Promise<(PluginEvent | null)[]>
    ingestEvent: (queue: Queue, event: PluginEvent) => Promise<IngestEventResponse>
}

function pauseQueueIfFull(queue: Queue, server: PluginsServer, piscina?: Piscina) {
    if ((piscina?.queueSize || 0) > (server.WORKER_CONCURRENCY || 4) * (server.WORKER_CONCURRENCY || 4)) {
        queue.pause()
    }
}

export async function startQueue(
    server: PluginsServer,
    piscina?: Piscina,
    workerMethods: Partial<WorkerMethods> = {}
): Promise<Queue> {
    const relevantStartQueue = server.KAFKA_ENABLED ? startQueueKafka : startQueueRedis
    const mergedWorkerMethods = {
        processEvent: (queue: Queue, event: PluginEvent) => {
            pauseQueueIfFull(queue, server, piscina)
            return piscina!.runTask({ task: 'processEvent', args: { event } })
        },
        processEventBatch: (queue: Queue, batch: PluginEvent[]) => {
            pauseQueueIfFull(queue, server, piscina)
            return piscina!.runTask({ task: 'processEventBatch', args: { batch } })
        },
        ingestEvent: (queue: Queue, event: PluginEvent) => {
            pauseQueueIfFull(queue, server, piscina)
            return piscina!.runTask({ task: 'ingestEvent', args: { event } })
        },
        ...workerMethods,
    }

    try {
        return await relevantStartQueue(server, mergedWorkerMethods)
    } catch (error) {
        status.error('💥', 'Failed to start event queue:\n', error)
        throw error
    }
}

async function startQueueRedis(server: PluginsServer, workerMethods: WorkerMethods): Promise<Queue> {
    const celeryQueue = new Worker(server.redis, server.PLUGINS_CELERY_QUEUE)
    const client = new Client(server.redis, server.CELERY_DEFAULT_QUEUE)

    celeryQueue.register(
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
                const processedEvent = await workerMethods.processEvent(celeryQueue, event)
                if (processedEvent) {
                    if (server.PLUGIN_SERVER_INGESTION) {
                        await workerMethods.ingestEvent(celeryQueue, processedEvent)
                    } else {
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
                }
            } catch (e) {
                Sentry.captureException(e)
            }
        }
    )

    celeryQueue.start()

    return celeryQueue
}

async function startQueueKafka(server: PluginsServer, workerMethods: WorkerMethods): Promise<Queue> {
    const kafkaQueue: Queue = new KafkaQueue(
        server,
        (batch: PluginEvent[]) => workerMethods.processEventBatch(kafkaQueue, batch),
        server.PLUGIN_SERVER_INGESTION
            ? async (event) => {
                  await workerMethods.ingestEvent(kafkaQueue, event)
              }
            : async () => {
                  // no op, but defining to avoid undefined issues
              }
    )
    await kafkaQueue.start()

    return kafkaQueue
}
