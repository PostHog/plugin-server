import { Queue } from '../../types'

export class QueuePool implements Queue {
    private concurrency: number
    private queues: Queue[] | undefined

    constructor(concurrency: number, builder: (queuePool: Queue, index: number) => Queue) {
        this.concurrency = concurrency
        this.queues = [...Array(concurrency)].map((_, i) => builder(this, i))
    }

    async start(): Promise<void> {
        await Promise.all(this.queues?.map((queue) => queue.start()) || [])
    }

    async pause(): Promise<void> {
        await Promise.all(this.queues?.map((queue) => queue.pause()) || [])
    }

    resume(): void {
        this.queues?.forEach((queue) => queue.resume())
    }

    isPaused(): boolean {
        return !!this.queues?.some((queue) => queue.isPaused())
    }

    async stop(): Promise<void> {
        await Promise.all(this.queues?.map((queue) => queue.stop()) || [])
    }
}
