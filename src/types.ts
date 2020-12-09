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

export interface PluginsServerConfig {
    WORKER_CONCURRENCY: number
    TASKS_PER_WORKER: number
    CELERY_DEFAULT_QUEUE: string
    DATABASE_URL: string
    KAFKA_HOSTS?: string
    EE_ENABLED?: boolean
    PLUGINS_CELERY_QUEUE: string
    REDIS_URL: string
    BASE_DIR: string
    PLUGINS_RELOAD_PUBSUB_CHANNEL: string
    DISABLE_WEB: boolean
    WEB_PORT: number
    WEB_HOSTNAME: string
    STATSD_HOST?: string
    STATSD_PORT: number
    STATSD_PREFIX: string
    LOG_LEVEL: LogLevel

    __jestMock?: {
        getPluginRows: Plugin[]
        getPluginConfigRows: PluginConfig[]
        getPluginAttachmentRows: PluginAttachmentDB[]
    }
}
export type PluginsServerConfigKey = Exclude<keyof PluginsServerConfig, '__jestMock'>

export interface PluginsServer extends PluginsServerConfig {
    // active connections to postgres and redis
    db: Pool
    redis: Redis
    statsd: StatsD | null
    // currently enabled plugin status
    plugins: Map<PluginId, Plugin>
    pluginConfigs: Map<PluginConfigId, PluginConfig>
    pluginConfigsPerTeam: Map<TeamId, PluginConfig[]>
    defaultConfigs: PluginConfig[]
}

export type PluginId = number
export type PluginConfigId = number
export type TeamId = number

export interface Plugin {
    id: PluginId
    name: string
    description: string
    url: string
    config_schema: Record<string, PluginConfigSchema> | PluginConfigSchema[]
    tag: string
    archive: Buffer | null
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

export interface PluginScript {
    plugin: Plugin
    script: VMScript
    processEvent: boolean
    setupTeam: boolean
}

export interface PluginConfigVMReponse {
    vm: VM
    methods: {
        processEvent: (event: PluginEvent) => Promise<PluginEvent>
        processEventBatch: (batch: PluginEvent[]) => Promise<PluginEvent[]>
    }
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

export type Data = {
    event: string
    properties: Properties
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
    text: string
    tag_name: string
    href: string
    attr_class: string[]
    attr_id: string
    nth_child: number
    nth_of_type: number
    attributes: Record<string, string>
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
