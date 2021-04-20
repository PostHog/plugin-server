import { EnqueuedRetry, OnRetryCallback, RetryQueue } from '../../types'
import Timeout = NodeJS.Timeout
import * as fs from 'fs'

export class FsQueue implements RetryQueue {
    paused: boolean
    started: boolean
    interval: Timeout | null
    filename: string

    constructor(filename = '/tmp/fs-queue-file.txt') {
        if (process.env.NODE_ENV !== 'test') {
            throw new Error('Can not use FsQueue outside tests')
        }
        this.paused = false
        this.started = false
        this.interval = null
        this.filename = filename
        // this.queued = []
    }

    enqueue(retry: EnqueuedRetry): Promise<void> | void {
        fs.appendFileSync(this.filename, `${JSON.stringify(retry)}\n`)
    }

    startConsumer(onRetry: OnRetryCallback): void {
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
                .map((s) => {
                    try {
                        return JSON.parse(s) as EnqueuedRetry
                    } catch (e) {
                        return null
                    }
                })
                .filter((a) => !!a) as EnqueuedRetry[]

            const newQueue = queue.filter((element) => element.timestamp < timestamp)
            if (newQueue.length > 0) {
                const oldQueue = queue.filter((element) => element.timestamp >= timestamp)
                fs.writeFileSync(this.filename, `${oldQueue.map((q) => JSON.stringify(q)).join('\n')}\n`)

                void onRetry(newQueue)
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
