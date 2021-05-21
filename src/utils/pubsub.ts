import { Redis } from 'ioredis'

import { PluginsServerConfig } from '../types'
import { createRedis } from './utils'

export type PubSubTask = ((message: string) => void) | ((message: string) => Promise<void>)

export interface PubSubTaskMap {
    [channel: string]: PubSubTask
}

export class PubSub {
    private serverConfig: PluginsServerConfig
    private redis: Redis | null
    public taskMap: PubSubTaskMap

    constructor(serverConfig: PluginsServerConfig, taskMap: PubSubTaskMap = {}) {
        this.serverConfig = serverConfig
        this.redis = null
        this.taskMap = taskMap
    }

    public async start(): Promise<void> {
        if (this.redis) {
            throw new Error('Started PubSub cannot be started again!')
        }
        this.redis = await createRedis(this.serverConfig)
        await this.redis.subscribe(Object.keys(this.taskMap))
        this.redis.on('message', (channel: string, message: string) => {
            const task: PubSubTask | undefined = this.taskMap[channel]
            if (!task) {
                throw new Error(
                    `Received a pubsub message for unassociated channel ${channel}! Associated channels are: ${Object.keys(
                        this.taskMap
                    )}`
                )
            }
            void task(message)
        })
    }

    public async stop(): Promise<void> {
        if (!this.redis) {
            throw new Error('Unstarted PubSub cannot be stopped!')
        }
        await this.redis.unsubscribe()
        this.redis.disconnect()
        this.redis = null
    }
}
