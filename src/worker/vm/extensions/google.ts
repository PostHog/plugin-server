import * as BigQuery from '@google-cloud/bigquery'

export interface DummyCloud {
    bigquery: typeof BigQuery
}

export interface DummyGoogle {
    cloud: DummyCloud
}

export function createGoogle(): DummyGoogle {
    return {
        cloud: {
            bigquery: BigQuery,
        },
    }
}
