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
    await clickhouse.query('TRUNCATE events').toPromise()
    await clickhouse.query('TRUNCATE events_mv').toPromise()
    await clickhouse.query('TRUNCATE person').toPromise()
    await clickhouse.query('TRUNCATE person_distinct_id').toPromise()
    await clickhouse.query('TRUNCATE person_mv').toPromise()
    await clickhouse.query('TRUNCATE person_static_cohort').toPromise()
    await clickhouse.query('TRUNCATE session_recording_events').toPromise()
    await clickhouse.query('TRUNCATE session_recording_events_mv').toPromise()
}
