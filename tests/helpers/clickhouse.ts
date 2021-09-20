import ClickHouse from '@posthog/clickhouse'

import { defaultConfig } from '../../src/config/config'
import { PluginsServerConfig } from '../../src/types'

export async function resetTestDatabaseClickhouse(extraServerConfig: Partial<PluginsServerConfig>): Promise<void> {
    const config = { ...defaultConfig, ...extraServerConfig }
    console.log('start clickhouse')
    const clickhouse = new ClickHouse({
        host: config.CLICKHOUSE_HOST,
        port: 8123,
        dataObjects: true,
        queryOptions: {
            database: config.CLICKHOUSE_DATABASE,
            output_format_json_quote_64bit_integers: false,
        },
    })
    console.log('start truncate')

    await clickhouse.querying('TRUNCATE events')
    await clickhouse.querying('TRUNCATE events_mv')
    await clickhouse.querying('TRUNCATE person')
    await clickhouse.querying('TRUNCATE person_distinct_id')
    await clickhouse.querying('TRUNCATE person_mv')
    await clickhouse.querying('TRUNCATE person_static_cohort')
    await clickhouse.querying('TRUNCATE session_recording_events')
    await clickhouse.querying('TRUNCATE session_recording_events_mv')
    await clickhouse.querying('TRUNCATE plugin_log_entries')
    console.log('finish clickhouse')
}
