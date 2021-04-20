import * as Sentry from '@sentry/node'

import { EnqueuedRetry, OnRetryCallback, PluginsServer, RetryQueue } from '../../types'
import { FsQueue } from './fs-queue'

const queues = {
    fs: () => new FsQueue(),
}

export class RetryQueueManager implements RetryQueue {
    pluginsServer: PluginsServer
    retryQueues: RetryQueue[]

    constructor(pluginsServer: PluginsServer) {
        this.pluginsServer = pluginsServer

        this.retryQueues = pluginsServer.RETRY_QUEUES.split(',')
            .map((q) => q.trim())
            .map(
                (queue): RetryQueue => {
                    if (queues[queue as keyof typeof queues]) {
                        return queues[queue as keyof typeof queues]()
                    } else {
                        throw new Error(`Unknown retry queue "${queue}"`)
                    }
                }
            )
    }

    async enqueue(retry: EnqueuedRetry): Promise<void> {
        for (const retryQueue of this.retryQueues) {
            try {
                await retryQueue.enqueue(retry)
                return
            } catch (error) {
                // if one fails, take the next queue
                Sentry.captureException(error, {
                    extra: {
                        retry: JSON.stringify(retry),
                        queue: retryQueue.toString(),
                        queues: this.retryQueues.map((q) => q.toString()),
                    },
                })
            }
        }
        throw new Error('No RetryQueue available')
    }

    async startConsumer(onRetry: OnRetryCallback): Promise<void> {
        await Promise.all(this.retryQueues.map((r) => r.startConsumer(onRetry)))
    }

    async stopConsumer(): Promise<void> {
        await Promise.all(this.retryQueues.map((r) => r.stopConsumer()))
    }

    async pauseConsumer(): Promise<void> {
        await Promise.all(this.retryQueues.map((r) => r.pauseConsumer()))
    }

    isConsumerPaused(): boolean {
        return !!this.retryQueues.find((r) => r.isConsumerPaused())
    }

    async resumeConsumer(): Promise<void> {
        await Promise.all(this.retryQueues.map((r) => r.resumeConsumer()))
    }
}
