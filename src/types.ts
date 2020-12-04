import { Pool } from 'pg'
import { Redis } from 'ioredis'
import { PluginEvent, PluginAttachment, PluginConfigSchema } from 'posthog-plugins'
import { VM, VMScript } from 'vm2'
import { DateTime } from 'luxon'

export interface PluginsServerConfig {
    CELERY_DEFAULT_QUEUE: string
    DATABASE_URL: string // Postgres database URL
    KAFKA_HOSTS: string // comma-delimited Kafka hosts
    EE_ENABLED: boolean // whether EE features Kafka + ClickHouse are enabled
    PLUGINS_CELERY_QUEUE: string
    REDIS_URL: string
    BASE_DIR: string
    PLUGINS_RELOAD_PUBSUB_CHANNEL: string
    DISABLE_WEB: boolean
    WEB_PORT: number
    WEB_HOSTNAME: string
}

export interface PluginsServer extends PluginsServerConfig {
    db: Pool
    redis: Redis
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
    plugin: Plugin
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
    }
}

export interface EventUsage {
    event: string
    usage_count: number
    volume: number
}

export interface PropertyUsage {
    key: string
    usage_count: number
    volume: number
}

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

export type Data = Record<string, any>
export type Properties = Record<string, any>

export interface Event {
    id: number
    distinct_id: string
    ip: string
    site_url: string
    data: Data
    team_id: number
    now: string
    sent_at: string
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

export type User = Record<string, any> // not really typed as not needed so far

export interface Person {
    id: number
    created_at: DateTime
    team: Team
    properties: Properties
    is_user: User
    is_identified: boolean
    uuid: string
}
