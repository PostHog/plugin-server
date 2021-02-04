import { defaultConfig } from '../../src/config'
import ClickHouse from '@posthog/clickhouse'
import { PluginsServerConfig } from '../../src/types'

export async function resetTestDatabaseClickhouse(extraServerConfig: Partial<PluginsServerConfig>): Promise<void> {
    const config = { ...defaultConfig, ...extraServerConfig }
    const clickhouse = new ClickHouse({
        host: config.CLICKHOUSE_HOST,
        port: 8123,
        queryOptions: {
            database: config.CLICKHOUSE_DATABASE,
        },
    })
    await clickhouse.querying('TRUNCATE events')
    await clickhouse.querying('TRUNCATE events_mv')
    await clickhouse.querying('TRUNCATE person')
    await clickhouse.querying('TRUNCATE person_distinct_id')
    await clickhouse.querying('TRUNCATE person_mv')
    await clickhouse.querying('TRUNCATE person_static_cohort')
    await clickhouse.querying('TRUNCATE session_recording_events')
    await clickhouse.querying('TRUNCATE session_recording_events_mv')
}
