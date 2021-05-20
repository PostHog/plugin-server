import { S3 } from 'aws-sdk'
import { ManagedUpload } from 'aws-sdk/clients/s3'
import { randomBytes } from 'crypto'
import { DateTime } from 'luxon'
import { gunzipSync, gzipSync } from 'zlib'

import { EnqueuedJob, JobQueue, OnJobCallback, PluginsServerConfig } from '../../../types'

const S3_POLL_INTERVAL = 5000

export class S3Queue implements JobQueue {
    serverConfig: PluginsServerConfig
    started: boolean
    paused: boolean
    s3: S3 | null
    onJob: OnJobCallback | null
    runner: NodeJS.Timeout | null

    constructor(serverConfig: PluginsServerConfig) {
        this.serverConfig = serverConfig
        this.started = false
        this.paused = false
        this.s3 = null
        this.onJob = null
        this.runner = null
    }

    // producer

    async connectProducer(): Promise<void> {
        await this.connectS3()
    }

    async enqueue(retry: EnqueuedJob): Promise<void> {
        if (!this.s3) {
            throw new Error('S3 object not initialized')
        }
        const date = new Date(retry.timestamp).toISOString()
        const [day, time] = date.split('T')
        const dayTime = `${day.split('-').join('')}-${time.split(':').join('')}`
        const suffix = randomBytes(8).toString('hex')

        const params = {
            Bucket: this.serverConfig.JOB_QUEUE_S3_BUCKET_NAME,
            Key: `${this.serverConfig.JOB_QUEUE_S3_PREFIX || ''}${day}/${dayTime}-${suffix}.json.gz`,
            Body: gzipSync(Buffer.from(JSON.stringify(retry), 'utf8')),
        }

        await new Promise((resolve, reject) => {
            this.s3?.upload(params, (err: Error, data: ManagedUpload.SendData) => (err ? reject(err) : resolve(data)))
        })
    }

    disconnectProducer(): void {
        // nothing to disconnect
    }

    // consumer

    async startConsumer(onJob: OnJobCallback): Promise<void> {
        this.started = true
        this.onJob = onJob
        await this.syncState()
    }

    async stopConsumer(): Promise<void> {
        this.started = false
        await this.syncState()
    }

    async pauseConsumer(): Promise<void> {
        this.paused = true
        await this.syncState()
    }

    isConsumerPaused(): boolean {
        return this.paused
    }

    async resumeConsumer(): Promise<void> {
        this.paused = false
        await this.syncState()
    }

    async readState(): Promise<void> {
        if (!this.s3) {
            throw new Error('S3 object not initialized')
        }
        let nextPollTimeout = S3_POLL_INTERVAL
        const response = await this.listObjects()
        if (response.length > 0) {
            nextPollTimeout = 10
            for (const filename of response) {
                const object: S3.Types.GetObjectOutput = await new Promise((resolve, reject) =>
                    this.s3?.getObject(
                        { Bucket: this.serverConfig.JOB_QUEUE_S3_BUCKET_NAME, Key: filename },
                        (err, data) => (err ? reject(err) : resolve(data))
                    )
                )
                if (object && object.Body) {
                    const job: EnqueuedJob = JSON.parse(gunzipSync(object.Body as Buffer).toString('utf8'))
                    await this.onJob?.([job])
                    await new Promise((resolve, reject) =>
                        this.s3?.deleteObject(
                            { Bucket: this.serverConfig.JOB_QUEUE_S3_BUCKET_NAME, Key: filename },
                            (err, data) => (err ? reject(err) : resolve(data))
                        )
                    )
                }
            }
        }
        if (this.started && !this.paused) {
            this.runner = setTimeout(() => this.readState(), nextPollTimeout)
        }
    }

    private async syncState(): Promise<void> {
        if (this.started && !this.paused) {
            if (!this.runner) {
                await this.connectS3()
                this.runner = setTimeout(() => this.readState(), S3_POLL_INTERVAL)
            }
        } else {
            if (this.runner) {
                clearTimeout(this.runner)
            }
        }
    }

    // S3 connection utils

    async connectS3(): Promise<void> {
        if (!this.s3) {
            this.s3 = await this.getS3()
        }
    }

    private async listObjects(s3 = this.s3): Promise<any[]> {
        if (!s3) {
            throw new Error('S3 object not initialized')
        }
        const response: S3.ListObjectsV2Output = await new Promise((resolve, reject) =>
            s3.listObjectsV2(
                {
                    Bucket: this.serverConfig.JOB_QUEUE_S3_BUCKET_NAME,
                    Prefix: this.serverConfig.JOB_QUEUE_S3_PREFIX,
                    MaxKeys: 100,
                },
                (err, data) => (err ? reject(err) : resolve(data))
            )
        )

        const now = DateTime.utc()

        return (response.Contents || [])
            .filter(({ Key }) => {
                // Key: `${this.serverConfig.JOB_QUEUE_S3_PREFIX || ''}${day}/${dayTime}-${suffix}.json.gz`,
                const filename = (Key || '').substring(this.serverConfig.JOB_QUEUE_S3_PREFIX.length).split('/')[1]
                const match = filename.match(
                    /^([0-9]{4})([0-9]{2})([0-9]{2})\-([0-9]{2})([0-9]{2})([0-9]{2})\.([0-9]+)Z\-[a-f0-9]+\.json\.gz$/
                )
                if (match) {
                    const [year, month, day, hour, minute, second, millisecond] = match
                        .slice(1)
                        .map((num) => parseInt(num))
                    const date = DateTime.utc(year, month, day, hour, minute, second, millisecond)
                    if (date <= now) {
                        return true
                    }
                }
                return false
            })
            .map(({ Key }) => Key)
    }

    private async getS3(): Promise<S3> {
        if (!this.serverConfig.JOB_QUEUE_S3_AWS_ACCESS_KEY) {
            throw new Error('AWS access key missing!')
        }
        if (!this.serverConfig.JOB_QUEUE_S3_AWS_SECRET_ACCESS_KEY) {
            throw new Error('AWS secret access key missing!')
        }
        if (!this.serverConfig.JOB_QUEUE_S3_AWS_REGION) {
            throw new Error('AWS region missing!')
        }
        if (!this.serverConfig.JOB_QUEUE_S3_BUCKET_NAME) {
            throw new Error('S3 bucket name missing!')
        }

        const s3 = new S3({
            accessKeyId: this.serverConfig.JOB_QUEUE_S3_AWS_ACCESS_KEY,
            secretAccessKey: this.serverConfig.JOB_QUEUE_S3_AWS_SECRET_ACCESS_KEY,
            region: this.serverConfig.JOB_QUEUE_S3_AWS_REGION,
        })
        await this.listObjects(s3) // check that we can connect

        return s3
    }
}
