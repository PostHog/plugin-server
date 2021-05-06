import Piscina from '@posthog/piscina'
import { PluginEvent } from '@posthog/plugin-scaffold'
import * as Sentry from '@sentry/node'

import { PluginsServer, Queue, WorkerMethods } from '../../types'
import { status } from '../../utils/status'
import { sanitizeEvent, UUIDT } from '../../utils/utils'
import { CeleryQueue } from './celery-queue'
import { KafkaQueue } from './kafka-queue'

export function pauseQueueIfWorkerFull(
    pause: undefined | (() => void | Promise<void>),
    server: PluginsServer,
    piscina?: Piscina
): void {
    if (pause && (piscina?.queueSize || 0) > (server.WORKER_CONCURRENCY || 4) * (server.WORKER_CONCURRENCY || 4)) {
        void pause()
    }
}

export async function startQueue(
    server: PluginsServer,
    piscina: Piscina,
    workerMethods: Partial<WorkerMethods> = {}
): Promise<Queue> {
    const mergedWorkerMethods = {
        onEvent: (event: PluginEvent) => {
            server.lastActivity = new Date().valueOf()
            server.lastActivityType = 'onEvent'
            return piscina.runTask({ task: 'onEvent', args: { event } })
        },
        onSnapshot: (event: PluginEvent) => {
            server.lastActivity = new Date().valueOf()
            server.lastActivityType = 'onSnapshot'
            return piscina.runTask({ task: 'onSnapshot', args: { event } })
        },
        processEvent: (event: PluginEvent) => {
            server.lastActivity = new Date().valueOf()
            server.lastActivityType = 'processEvent'
            return piscina.runTask({ task: 'processEvent', args: { event } })
        },
        processEventBatch: (batch: PluginEvent[]) => {
            server.lastActivity = new Date().valueOf()
            server.lastActivityType = 'processEventBatch'
            return piscina.runTask({ task: 'processEventBatch', args: { batch } })
        },
        ingestEvent: (event: PluginEvent) => {
            server.lastActivity = new Date().valueOf()
            server.lastActivityType = 'ingestEvent'
            return piscina.runTask({ task: 'ingestEvent', args: { event } })
        },
        ...workerMethods,
    }

    try {
        if (server.KAFKA_ENABLED) {
            return await startQueueKafka(server, piscina, mergedWorkerMethods)
        } else {
            return startQueueRedis(server, piscina, mergedWorkerMethods)
        }
    } catch (error) {
        status.error('💥', 'Failed to start event queue:\n', error)
        throw error
    }
}

function startQueueRedis(server: PluginsServer, piscina: Piscina | undefined, workerMethods: WorkerMethods): Queue {
    const celeryQueue = new CeleryQueue(server.db, server.PLUGINS_CELERY_QUEUE)

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

                // do not run processEvent on snapshots
                const processedEvent = event.event === '$snapshot' ? event : await workerMethods.processEvent(event)

                if (processedEvent) {
                    pauseQueueIfWorkerFull(() => celeryQueue.pause(), server, piscina)

                    await Promise.all([
                        workerMethods.ingestEvent(processedEvent),
                        processedEvent.event === '$snapshot'
                            ? workerMethods.onSnapshot(processedEvent)
                            : workerMethods.onEvent(processedEvent),
                    ])
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

async function startQueueKafka(server: PluginsServer, piscina: Piscina, workerMethods: WorkerMethods): Promise<Queue> {
    const kafkaQueue: Queue = new KafkaQueue(server, piscina, workerMethods)
    await kafkaQueue.start()

    return kafkaQueue
}
