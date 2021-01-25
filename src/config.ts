import { LogLevel, PluginsServerConfig } from './types'

export const defaultConfig = overrideWithEnv(getDefaultConfig())
export const configHelp = getConfigHelp()

export function getDefaultConfig(): PluginsServerConfig {
    const isTestEnv = process.env.NODE_ENV === 'test'

    return {
        CELERY_DEFAULT_QUEUE: 'celery',
        DATABASE_URL: isTestEnv ? 'postgres://localhost:5432/test_posthog' : 'postgres://localhost:5432/posthog',
        CLICKHOUSE_HOST: 'localhost',
        CLICKHOUSE_DATABASE: 'default',
        CLICKHOUSE_USERNAME: 'default',
        CLICKHOUSE_PASSWORD: null,
        CLICKHOUSE_CA: null,
        CLICKHOUSE_SECURE: false,
        KAFKA_ENABLED: false,
        KAFKA_HOSTS: null,
        KAFKA_CLIENT_CERT_B64: null,
        KAFKA_CLIENT_CERT_KEY_B64: null,
        KAFKA_TRUSTED_CERT_B64: null,
        PLUGINS_CELERY_QUEUE: 'posthog-plugins',
        REDIS_URL: 'redis://127.0.0.1',
        BASE_DIR: '.',
        PLUGINS_RELOAD_PUBSUB_CHANNEL: 'reload-plugins',
        DISABLE_WEB: true,
        WEB_PORT: 3008,
        WEB_HOSTNAME: '0.0.0.0',
        WORKER_CONCURRENCY: 0, // use all cores
        TASKS_PER_WORKER: 10,
        LOG_LEVEL: LogLevel.Info,
        SENTRY_DSN: null,
        STATSD_HOST: null,
        STATSD_PORT: 8125,
        STATSD_PREFIX: 'plugin-server.',
        SCHEDULE_LOCK_TTL: 60,
    }
}

export function getConfigHelp(): Record<keyof PluginsServerConfig, string> {
    return {
        CELERY_DEFAULT_QUEUE: 'Celery outgoing queue',
        PLUGINS_CELERY_QUEUE: 'Celery incoming queue',
        DATABASE_URL: 'Postgres database URL',
        CLICKHOUSE_HOST: 'ClickHouse host',
        CLICKHOUSE_DATABASE: 'ClickHouse database',
        CLICKHOUSE_USERNAME: 'ClickHouse username',
        CLICKHOUSE_PASSWORD: 'ClickHouse password',
        CLICKHOUSE_CA: 'ClickHouse CA certs',
        CLICKHOUSE_SECURE: 'Secure ClickHouse connection',
        REDIS_URL: 'Redis store URL',
        BASE_DIR: 'base path for resolving local plugins',
        PLUGINS_RELOAD_PUBSUB_CHANNEL: 'Redis channel for reload events',
        DISABLE_WEB: 'whether to disable web server',
        WEB_PORT: 'port for web server to listen on',
        WEB_HOSTNAME: 'hostname for web server to listen on',
        WORKER_CONCURRENCY: 'number of concurrent worker threads',
        TASKS_PER_WORKER: 'number of parallel tasks per worker thread',
        LOG_LEVEL: 'minimum log level',
        KAFKA_ENABLED: 'use Kafka instead of Celery to ingest events',
        KAFKA_HOSTS: 'comma-delimited Kafka hosts',
        KAFKA_CLIENT_CERT_B64: 'Kafka certificate in Base64',
        KAFKA_CLIENT_CERT_KEY_B64: 'Kafka certificate key in Base64',
        KAFKA_TRUSTED_CERT_B64: 'Kafka trusted CA in Base64',
        SENTRY_DSN: 'Sentry ingestion URL',
        STATSD_HOST: 'StatsD host - integration disabled if this is not provided',
        STATSD_PORT: 'StatsD port',
        STATSD_PREFIX: 'StatsD prefix',
        SCHEDULE_LOCK_TTL: 'How many seconds to hold the lock for the schedule',
    }
}

export function overrideWithEnv(
    config: PluginsServerConfig,
    env: Record<string, string | undefined> = process.env
): PluginsServerConfig {
    const defaultConfig = getDefaultConfig()

    const newConfig: PluginsServerConfig = { ...config }
    for (const key of Object.keys(config)) {
        if (typeof env[key] !== 'undefined') {
            if (typeof defaultConfig[key] === 'number') {
                newConfig[key] = env[key]?.indexOf('.') ? parseFloat(env[key]!) : parseInt(env[key]!)
            } else if (typeof defaultConfig[key] === 'boolean') {
                newConfig[key] = env[key]?.toLowerCase() === 'true' || env[key] === '1'
            } else {
                newConfig[key] = env[key]
            }
        }
    }
    return newConfig as PluginsServerConfig
}
