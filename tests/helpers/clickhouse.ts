import { defaultConfig } from '../../src/config'
import { ClickHouse } from 'clickhouse'

export async function resetTestDatabaseClickhouse(): Promise<void> {
    const clickhouse = new ClickHouse({
        url: `http://$${defaultConfig.CLICKHOUSE_HOST}`,
        port: 8123,
        config: {
            database: defaultConfig.CLICKHOUSE_DATABASE,
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
