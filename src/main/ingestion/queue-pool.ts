import { Queue } from '../../types'

export class QueuePool implements Queue {
    private concurrency: number
    private queuePromises: Promise<Queue>[]
    private queues: Queue[] | undefined

    constructor(concurrency: number, builder: (queuePool?: Queue) => Promise<Queue>) {
        this.concurrency = concurrency
        this.queuePromises = [...Array(concurrency)].map((_, i) => builder(this))
    }

    async start(): Promise<void> {
        this.queues = await Promise.all(this.queuePromises)
        await Promise.all(this.queues.map((queue) => queue.start()))
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
