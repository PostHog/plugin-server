import { Pool } from 'pg'
import { Redis } from 'ioredis'
import { PluginEvent, PluginAttachment, PluginConfigSchema } from 'posthog-plugins'
import { VM, VMScript } from 'vm2'
import { DateTime } from 'luxon'
import { StatsD } from 'hot-shots'

export enum LogLevel {
    Debug = 'debug',
    Info = 'info',
    Log = 'log',
    Warn = 'warn',
    Error = 'error',
    None = 'none',
}

export interface PluginsServerConfig extends Record<string, any> {
    WORKER_CONCURRENCY: number
    TASKS_PER_WORKER: number
    CELERY_DEFAULT_QUEUE: string
    DATABASE_URL: string
    KAFKA_HOSTS: string | null
    EE_ENABLED: boolean
    PLUGINS_CELERY_QUEUE: string
    REDIS_URL: string
    BASE_DIR: string
    PLUGINS_RELOAD_PUBSUB_CHANNEL: string
    DISABLE_WEB: boolean
    WEB_PORT: number
    WEB_HOSTNAME: string
    LOG_LEVEL: LogLevel
    SENTRY_DSN: string | null
    STATSD_HOST: string | null
    STATSD_PORT: number
    STATSD_PREFIX: string

    __jestMock?: {
        getPluginRows: Plugin[]
        getPluginConfigRows: PluginConfig[]
        getPluginAttachmentRows: PluginAttachmentDB[]
    }
}

export interface PluginsServer extends PluginsServerConfig {
    // active connections to postgres and redis
    db: Pool
    redis: Redis
    statsd: StatsD | undefined

    // currently enabled plugin status
    plugins: Map<PluginId, Plugin>
    pluginConfigs: Map<PluginConfigId, PluginConfig>
    pluginConfigsPerTeam: Map<TeamId, PluginConfig[]>
    defaultConfigs: PluginConfig[]
    pluginSchedule: Record<string, PluginConfigId[]>
    pluginSchedulePromises: Record<string, Record<PluginConfigId, Promise<any> | null>>
}

export interface Queue {
    start: () => void
    stop: () => void
}

export type PluginId = number
export type PluginConfigId = number
export type TeamId = number

export interface Plugin {
    id: PluginId
    name: string
    plugin_type: 'local' | 'respository' | 'custom' | 'source'
    description?: string
    url?: string
    config_schema: Record<string, PluginConfigSchema> | PluginConfigSchema[]
    tag?: string
    archive: Buffer | null
    source?: string
    error?: PluginError
}

export interface PluginConfig {
    id: PluginConfigId
    team_id: TeamId
    plugin?: Plugin
    plugin_id: PluginId
    enabled: boolean
    order: number
    config: Record<string, unknown>
    error?: PluginError
    attachments?: Record<string, PluginAttachment>
    vm?: PluginConfigVMReponse | null
}

export interface PluginJsonConfig {
    name?: string
    description?: string
    url?: string
    main?: string
    lib?: string
    config?: Record<string, PluginConfigSchema> | PluginConfigSchema[]
}

export interface PluginError {
    message: string
    time: string
    name?: string
    stack?: string
    event?: PluginEvent | null
}

export interface PluginAttachmentDB {
    id: number
    team_id: TeamId
    plugin_config_id: PluginConfigId
    key: string
    content_type: string
    file_size: number | null
    file_name: string
    contents: Buffer | null
}

export interface PluginTask {
    name: string
    type: 'runEvery'
    exec: () => Promise<any>
}

export interface PluginConfigVMReponse {
    vm: VM
    methods: {
        processEvent: (event: PluginEvent) => Promise<PluginEvent>
        processEventBatch: (batch: PluginEvent[]) => Promise<PluginEvent[]>
    }
    tasks: Record<string, PluginTask>
}

// received via Kafka
interface EventMessage {
    distinct_id: string
    ip: string
    site_url: string
    team_id: number
}

export interface RawEventMessage extends EventMessage {
    data: string
    now: string
    sent_at: string // may be an empty string
}

export interface ParsedEventMessage extends EventMessage {
    data: EventData
    now: DateTime
    sent_at: DateTime | null
}

export interface EventData extends PluginEvent {
    properties?: Properties
    timestamp?: string
    $set?: Properties
    offset?: number
}

export type Properties = Record<string, any>
