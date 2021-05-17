import ClickHouse from '@posthog/clickhouse'
import { PluginAttachment, PluginConfigSchema, PluginEvent, Properties } from '@posthog/plugin-scaffold'
import { Pool as GenericPool } from 'generic-pool'
import { StatsD } from 'hot-shots'
import { Redis } from 'ioredis'
import { Kafka } from 'kafkajs'
import { DateTime } from 'luxon'
import { JobQueueManager } from 'main/job-queues/job-queue-manager'
import { Pool } from 'pg'
import { VM } from 'vm2'

import { DB } from './utils/db/db'
import { KafkaProducerWrapper } from './utils/db/kafka-producer-wrapper'
import { UUID } from './utils/utils'
import { EventsProcessor } from './worker/ingestion/process-event'
import { LazyPluginVM } from './worker/vm/lazy'

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
    TASK_TIMEOUT: number
    CELERY_DEFAULT_QUEUE: string
    DATABASE_URL: string
    POSTHOG_DB_NAME: string | null
    POSTHOG_DB_USER: string
    POSTHOG_DB_PASSWORD: string
    POSTHOG_POSTGRES_HOST: string
    POSTHOG_POSTGRES_PORT: number
    CLICKHOUSE_HOST: string
    CLICKHOUSE_DATABASE: string
    CLICKHOUSE_USER: string
    CLICKHOUSE_PASSWORD: string | null
    CLICKHOUSE_CA: string | null
    CLICKHOUSE_SECURE: boolean
    KAFKA_ENABLED: boolean
    KAFKA_HOSTS: string | null
    KAFKA_CLIENT_CERT_B64: string | null
    KAFKA_CLIENT_CERT_KEY_B64: string | null
    KAFKA_TRUSTED_CERT_B64: string | null
    KAFKA_CONSUMPTION_TOPIC: string | null
    KAFKA_PRODUCER_MAX_QUEUE_SIZE: number
    KAFKA_MAX_MESSAGE_BATCH_SIZE: number
    KAFKA_FLUSH_FREQUENCY_MS: number
    PLUGINS_CELERY_QUEUE: string
    REDIS_URL: string
    POSTHOG_REDIS_PASSWORD: string
    POSTHOG_REDIS_HOST: string
    POSTHOG_REDIS_PORT: number
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
    REDIS_POOL_MIN_SIZE: number
    REDIS_POOL_MAX_SIZE: number
    DISABLE_MMDB: boolean
    DISTINCT_ID_LRU_SIZE: number
    INTERNAL_MMDB_SERVER_PORT: number
    PLUGIN_SERVER_IDLE: boolean
    JOB_QUEUES: string
    JOB_QUEUE_GRAPHILE_URL: string
    JOB_QUEUE_GRAPHILE_SCHEMA: string
    JOB_QUEUE_GRAPHILE_PREPARED_STATEMENTS: boolean
    CRASH_IF_NO_PERSISTENT_JOB_QUEUE: boolean
    STALENESS_RESTART_SECONDS: number
}

export interface PluginsServer extends PluginsServerConfig {
    instanceId: UUID
    // active connections to Postgres, Redis, ClickHouse, Kafka, StatsD
    db: DB
    postgres: Pool
    redisPool: GenericPool<Redis>
    clickhouse?: ClickHouse
    kafka?: Kafka
    kafkaProducer?: KafkaProducerWrapper
    statsd?: StatsD
    // currently enabled plugin status
    plugins: Map<PluginId, Plugin>
    pluginConfigs: Map<PluginConfigId, PluginConfig>
    pluginConfigsPerTeam: Map<TeamId, PluginConfig[]>
    pluginSchedule: Record<string, PluginConfigId[]> | null
    pluginSchedulePromises: Record<string, Record<PluginConfigId, Promise<any> | null>>
    // unique hash for each plugin config; used to verify IDs caught on stack traces for unhandled promise rejections
    pluginConfigSecrets: Map<PluginConfigId, string>
    pluginConfigSecretLookup: Map<string, PluginConfigId>
    // tools
    eventsProcessor: EventsProcessor
    jobQueueManager: JobQueueManager
    // diagnostics
    lastActivity: number
    lastActivityType: string
}

export interface Pausable {
    pause: () => Promise<void> | void
    resume: () => Promise<void> | void
    isPaused: () => boolean
}

export interface Queue extends Pausable {
    start: () => Promise<void> | void
    stop: () => Promise<void> | void
}

export type OnJobCallback = (queue: EnqueuedJob[]) => Promise<void> | void
export interface EnqueuedJob {
    type: string
    payload: Record<string, any>
    timestamp: number
    pluginConfigId: number
    pluginConfigTeam: number
}

export interface JobQueue {
    startConsumer: (onJob: OnJobCallback) => Promise<void> | void
    stopConsumer: () => Promise<void> | void
    pauseConsumer: () => Promise<void> | void
    resumeConsumer: () => Promise<void> | void
    isConsumerPaused: () => boolean

    connectProducer: () => Promise<void> | void
    enqueue: (job: EnqueuedJob) => Promise<void> | void
    disconnectProducer: () => Promise<void> | void
}

export type PluginId = number
export type PluginConfigId = number
export type TeamId = number

export interface Plugin {
    id: PluginId
    organization_id: string
    name: string
    plugin_type: 'local' | 'respository' | 'custom' | 'source'
    description?: string
    is_global: boolean
    is_preinstalled: boolean
    url?: string
    config_schema: Record<string, PluginConfigSchema> | PluginConfigSchema[]
    tag?: string
    archive: Buffer | null
    source?: string
    error?: PluginError
    from_json?: boolean
    from_web?: boolean
    created_at: string
    updated_at: string
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
    vm?: LazyPluginVM | null
    created_at: string
    updated_at: string
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
    team_id: TeamId | null
    plugin_config_id: PluginConfigId | null
    key: string
    content_type: string
    file_size: number | null
    file_name: string
    contents: Buffer | null
}

export enum PluginLogEntrySource {
    System = 'SYSTEM',
    Plugin = 'PLUGIN',
    Console = 'CONSOLE',
}

export enum PluginLogEntryType {
    Debug = 'DEBUG',
    Log = 'LOG',
    Info = 'INFO',
    Warn = 'WARN',
    Error = 'ERROR',
}

export interface PluginLogEntry {
    id: string
    team_id: number
    plugin_id: number
    plugin_config_id: number
    timestamp: string
    source: PluginLogEntrySource
    type: PluginLogEntryType
    message: string
    instance_id: string
}

export enum PluginTaskType {
    Job = 'job',
    Schedule = 'schedule',
}

export interface PluginTask {
    name: string
    type: PluginTaskType
    exec: (payload?: Record<string, any>) => Promise<any>
}

export type WorkerMethods = {
    onEvent: (event: PluginEvent) => Promise<void>
    onSnapshot: (event: PluginEvent) => Promise<void>
    processEvent: (event: PluginEvent) => Promise<PluginEvent | null>
    processEventBatch: (batch: PluginEvent[]) => Promise<(PluginEvent | null)[]>
    ingestEvent: (event: PluginEvent) => Promise<IngestEventResponse>
}

export interface PluginConfigVMReponse {
    vm: VM
    methods: {
        setupPlugin: () => Promise<void>
        teardownPlugin: () => Promise<void>
        onEvent: (event: PluginEvent) => Promise<void>
        onSnapshot: (event: PluginEvent) => Promise<void>
        processEvent: (event: PluginEvent) => Promise<PluginEvent>
        // DEPRECATED
        processEventBatch: (batch: PluginEvent[]) => Promise<PluginEvent[]>
    }
    tasks: Record<PluginTaskType, Record<string, PluginTask>>
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

/** Properties shared by RawEventMessage and EventMessage. */
export interface BaseEventMessage {
    distinct_id: string
    ip: string
    site_url: string
    team_id: number
    uuid: string
}

/** Raw event message as received via Kafka. */
export interface RawEventMessage extends BaseEventMessage {
    /** JSON-encoded object. */
    data: string
    /** ISO-formatted datetime. */
    now: string
    /** ISO-formatted datetime. May be empty! */
    sent_at: string
    /** JSON-encoded number. */
    kafka_offset: string
}

/** Usable event message. */
export interface EventMessage extends BaseEventMessage {
    data: PluginEvent
    now: DateTime
    sent_at: DateTime | null
}

/** Raw Organization row from database. */
export interface RawOrganization {
    id: string
    name: string
    created_at: string
    updated_at: string
}

/** Usable Team model. */
export interface Team {
    id: number
    uuid: string
    organization_id: string
    name: string
    anonymize_ips: boolean
    api_token: string
    app_urls: string[]
    completed_snippet_onboarding: boolean
    opt_out_capture: boolean
    slack_incoming_webhook: string
    session_recording_opt_in: boolean
    ingested_event: boolean
}

/** Usable Element model. */
export interface Element {
    text?: string
    tag_name?: string
    href?: string
    attr_id?: string
    attr_class?: string[]
    nth_child?: number
    nth_of_type?: number
    attributes?: Record<string, any>
    event_id?: number
    order?: number
    group_id?: number
}

export interface ElementGroup {
    id: number
    hash: string
    team_id: number
}

/** Usable Event model. */
export interface Event {
    id: number
    event?: string
    properties: Record<string, any>
    elements?: Element[]
    timestamp: string
    team_id: number
    distinct_id: string
    elements_hash: string
    created_at: string
}

export interface ClickHouseEvent extends Omit<Event, 'id' | 'elements' | 'elements_hash'> {
    uuid: string
    elements_chain: string
}

/** Properties shared by RawPerson and Person. */
export interface BasePerson {
    id: number
    team_id: number
    properties: Properties
    is_user_id: number
    is_identified: boolean
    uuid: string
}

/** Raw Person row from database. */
export interface RawPerson extends BasePerson {
    created_at: string
}

/** Usable Person model. */
export interface Person extends BasePerson {
    created_at: DateTime
}

/** Clickhouse Person model. */
export interface ClickHousePerson {
    id: string
    created_at: string
    team_id: number
    properties: string
    is_identified: number
    timestamp: string
}

/** Usable PersonDistinctId model. */
export interface PersonDistinctId {
    id: number
    team_id: number
    person_id: number
    distinct_id: string
}

/** ClickHouse PersonDistinctId model. */
export interface ClickHousePersonDistinctId {
    id: number
    team_id: number
    person_id: string
    distinct_id: string
}

/** Usable CohortPeople model. */
export interface CohortPeople {
    id: number
    cohort_id: number
    person_id: number
}

export interface SessionRecordingEvent {
    uuid: string
    timestamp: string
    team_id: number
    distinct_id: string
    session_id: string
    snapshot_data: string
    created_at: string
}

export interface PostgresSessionRecordingEvent extends Omit<SessionRecordingEvent, 'uuid'> {
    id: string
}

export enum TimestampFormat {
    ClickHouseSecondPrecision = 'clickhouse-second-precision',
    ClickHouse = 'clickhouse',
    ISO = 'iso',
}

export enum Database {
    ClickHouse = 'clickhouse',
    Postgres = 'postgres',
}

export interface ScheduleControl {
    stopSchedule: () => Promise<void>
    reloadSchedule: () => Promise<void>
}

export interface JobQueueConsumerControl {
    stop: () => Promise<void>
    resume: () => Promise<void> | void
}

export type IngestEventResponse = { success?: boolean; error?: string }

export interface EventDefinitionType {
    id: string
    name: string
    volume_30_day: number | null
    query_usage_30_day: number | null
    team_id: number
}

export interface PropertyDefinitionType {
    id: string
    name: string
    is_numerical: boolean
    volume_30_day: number | null
    query_usage_30_day: number | null
    team_id: number
}

export type PluginFunction = 'onEvent' | 'processEvent' | 'onSnapshot' | 'pluginTask'
