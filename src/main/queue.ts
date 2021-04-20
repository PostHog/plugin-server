import Piscina from '@posthog/piscina'
import { PluginEvent } from '@posthog/plugin-scaffold'
import * as Sentry from '@sentry/node'

import { status } from '../shared/status'
import { sanitizeEvent, UUIDT } from '../shared/utils'
import { IngestEventResponse, PluginsServer, Queue } from '../types'
import CeleryQueueWorker from './ingestion/celery-queue-worker'
import { KafkaQueue } from './ingestion/kafka-queue'

export type WorkerMethods = {
    processEvent: (event: PluginEvent) => Promise<PluginEvent | null>
    processEventBatch: (event: PluginEvent[]) => Promise<(PluginEvent | null)[]>
    ingestEvent: (event: PluginEvent) => Promise<IngestEventResponse>
}

export function pauseQueueIfWorkerFull(
    pause: undefined | (() => void | Promise<void>),
    server: PluginsServer,
    piscina?: Piscina
) {
    if (pause && (piscina?.queueSize || 0) > (server.WORKER_CONCURRENCY || 4) * (server.WORKER_CONCURRENCY || 4)) {
        void pause()
    }
}

export async function startQueue(
    server: PluginsServer,
    piscina?: Piscina,
    workerMethods: Partial<WorkerMethods> = {}
): Promise<Queue> {
    const mergedWorkerMethods = {
        processEvent: (event: PluginEvent) => {
            return piscina!.runTask({ task: 'processEvent', args: { event } })
        },
        processEventBatch: (batch: PluginEvent[]) => {
            return piscina!.runTask({ task: 'processEventBatch', args: { batch } })
        },
        ingestEvent: (event: PluginEvent) => {
            return piscina!.runTask({ task: 'ingestEvent', args: { event } })
        },
        ...workerMethods,
    }

    try {
        if (server.KAFKA_ENABLED) {
            return await startQueueKafka(server, mergedWorkerMethods)
        } else {
            return startQueueRedis(server, piscina, mergedWorkerMethods)
        }
    } catch (error) {
        status.error('💥', 'Failed to start event queue:\n', error)
        throw error
    }
}

function startQueueRedis(server: PluginsServer, piscina: Piscina | undefined, workerMethods: WorkerMethods): Queue {
    const celeryQueue = new CeleryQueueWorker(server.db, server.PLUGINS_CELERY_QUEUE)

    celeryQueue.register(
        'posthog.tasks.process_event.process_event_with_plugins',
        async (
            distinct_id: string,
            ip: string | null,
            site_url: string,
            data: Record<string, unknown>,
            team_id: number,
            now: string,
            sent_at?: string
        ) => {
            const event = sanitizeEvent({
                distinct_id,
                ip,
                site_url,
                team_id,
                now,
                sent_at,
                uuid: new UUIDT().toString(),
                ...data,
            } as PluginEvent)
            try {
                pauseQueueIfWorkerFull(() => celeryQueue.pause(), server, piscina)
                const processedEvent = await workerMethods.processEvent(event)
                if (processedEvent) {
                    pauseQueueIfWorkerFull(() => celeryQueue.pause(), server, piscina)
                    await workerMethods.ingestEvent(processedEvent)
                }
            } catch (e) {
                Sentry.captureException(e)
            }
        }
    )

    // run in the background
    void celeryQueue.start()

    return celeryQueue
}

async function startQueueKafka(server: PluginsServer, workerMethods: WorkerMethods): Promise<Queue> {
    const kafkaQueue: Queue = new KafkaQueue(
        server,
        (batch: PluginEvent[]) => workerMethods.processEventBatch(batch),
        async (event) => void (await workerMethods.ingestEvent(event))
    )
    await kafkaQueue.start()

    return kafkaQueue
}
