import { EnqueuedJob, JobQueue, OnJobCallback } from '../../../types'
import Timeout = NodeJS.Timeout
import * as fs from 'fs'
import * as path from 'path'

export class FsQueue implements JobQueue {
    paused: boolean
    started: boolean
    interval: Timeout | null
    filename: string

    constructor(filename?: string) {
        if (process.env.NODE_ENV !== 'test') {
            throw new Error('Can not use FsQueue outside tests')
        }
        this.paused = false
        this.started = false
        this.interval = null
        this.filename = filename || path.join(process.cwd(), 'tmp', 'fs-queue.txt')
    }

    connectProducer(): void {
        fs.mkdirSync(path.dirname(this.filename), { recursive: true })
        fs.writeFileSync(this.filename, '')
    }

    enqueue(job: EnqueuedJob): Promise<void> | void {
        fs.appendFileSync(this.filename, `${JSON.stringify(job)}\n`)
    }

    disconnectProducer(): void {
        // nothing to do
    }

    startConsumer(onJob: OnJobCallback): void {
        fs.writeFileSync(this.filename, '')
        this.started = true
        this.interval = setInterval(() => {
            if (this.paused) {
                return
            }
            const timestamp = new Date().valueOf()
            const queue = fs
                .readFileSync(this.filename)
                .toString()
                .split('\n')
                .filter((a) => a)
                .map((s) => JSON.parse(s) as EnqueuedJob)

            const newQueue = queue.filter((element) => element.timestamp < timestamp)
            if (newQueue.length > 0) {
                const oldQueue = queue.filter((element) => element.timestamp >= timestamp)
                fs.writeFileSync(this.filename, `${oldQueue.map((q) => JSON.stringify(q)).join('\n')}\n`)

                void onJob(newQueue)
            }
        }, 1000)
    }

    stopConsumer(): void {
        this.started = false
        this.interval && clearInterval(this.interval)
        fs.unlinkSync(this.filename)
    }

    pauseConsumer(): void {
        this.paused = true
    }

    isConsumerPaused(): boolean {
        return this.paused
    }

    resumeConsumer(): void {
        this.paused = false
    }
}
