import { Pool } from 'pg'
import { Redis } from 'ioredis'
import { Kafka, Producer } from 'kafkajs'
import { PluginEvent, PluginAttachment, PluginConfigSchema } from '@posthog/plugin-scaffold'
import { VM } from 'vm2'
import { DateTime } from 'luxon'
import { StatsD } from 'hot-shots'
import { EventsProcessor } from 'ingestion/process-event'
import { UUID } from './utils'

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
    CLICKHOUSE_HOST: string
    CLICKHOUSE_DATABASE: string
    CLICKHOUSE_USERNAME: string
    CLICKHOUSE_PASSWORD: string | null
    CLICKHOUSE_CA: string | null
    CLICKHOUSE_SECURE: boolean
    CLICKHOUSE_VERIFY: boolean
    KAFKA_ENABLED: boolean
    KAFKA_HOSTS: string | null
    KAFKA_CLIENT_CERT_B64: string | null
    KAFKA_CLIENT_CERT_KEY_B64: string | null
    KAFKA_TRUSTED_CERT_B64: string | null
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
    SCHEDULE_LOCK_TTL: number
}

export interface PluginsServer extends PluginsServerConfig {
    // active connections to Postgres, Redis, Kafka, StatsD
    db: Pool
    redis: Redis
    kafka: Kafka | undefined
    kafkaProducer: Producer | undefined
    statsd: StatsD | undefined
    // currently enabled plugin status
    plugins: Map<PluginId, Plugin>
    pluginConfigs: Map<PluginConfigId, PluginConfig>
    pluginConfigsPerTeam: Map<TeamId, PluginConfig[]>
    defaultConfigs: PluginConfig[]
    pluginSchedule: Record<string, PluginConfigId[]>
    pluginSchedulePromises: Record<string, Record<PluginConfigId, Promise<any> | null>>
    eventsProcessor: EventsProcessor
}

export interface Pausable {
    pause: () => Promise<void>
    resume: () => void
    isPaused: () => boolean
}

export interface Queue extends Pausable {
    start: () => void
    stop: () => void
}

export interface Queue {
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
    from_json?: boolean
    from_web?: boolean
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

export interface EventUsage {
    event: string
    usage_count: number | null
    volume: number | null
}

export interface PropertyUsage {
    key: string
    usage_count: number | null
    volume: number | null
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
    uuid: string
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

export interface Team {
    id: number
    name: string
    anonymize_ips: boolean
    api_token: string
    app_urls: string[]
    completed_snippet_onboarding: boolean
    event_names: string[]
    event_properties: string[]
    event_properties_numerical: string[]
    event_names_with_usage: EventUsage[]
    event_properties_with_usage: PropertyUsage[]
    opt_out_capture: boolean
    slack_incoming_webhook: string
    session_recording_opt_in: boolean
    plugins_opt_in: boolean
    ingested_event: boolean
}

export interface Element {
    text?: string
    tag_name?: string
    href?: string
    attr_id?: string
    attr_class?: string[]
    nth_child?: number
    nth_of_type?: number
    attributes: Record<string, any>
    event_id?: number
    order?: number
    group_id?: number
}

export type User = Record<string, any> // not really typed as not needed so far, only a placeholder for Person.is_user

export interface Person {
    id: number
    created_at: DateTime
    team_id: number
    properties: Properties
    is_user: User
    is_identified: boolean
    uuid: string
}

export interface PersonDistinctId {
    id: number
    team_id: number
    person_id: number
    distinct_id: string
}

export interface CohortPeople {
    id: number
    cohort_id: number
    person_id: number
}

export interface ParsedEventMessage extends EventMessage {
    data: PluginEvent
    now: DateTime
    sent_at: DateTime | null
    uuid: UUID
}
