import { Plugin, PluginEvent, PluginMeta, RetryError } from '@posthog/plugin-scaffold'
import { Client, QueryResult } from 'pg'

import { Hub, PluginConfig, PluginConfigVMInternalResponse, PluginTaskType } from '../../../../types'

type RedshiftImportUpgrade = Plugin<{
    global: {
        pgClient: Client
        eventsToIgnore: Set<string>
        sanitizedTableName: string
        importAndIngestEvents: (
            payload: ImportEventsJobPayload,
            meta: PluginMeta<RedshiftImportUpgrade>
        ) => Promise<void>
    }
    config: {
        clusterHost: string
        clusterPort: string
        dbName: string
        tableName: string
        dbUsername: string
        dbPassword: string
        eventsToIgnore: string
        orderByColumn: string
    }
}>

interface ImportEventsJobPayload extends Record<string, any> {
    offset: number
    retriesPerformedSoFar: number
}

interface ExecuteQueryResponse {
    error: Error | null
    queryResult: QueryResult<any> | null
}

// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace posthog {
    function capture(event: string, properties?: Record<string, any>): void
}

const sanitizeSqlIdentifier = (unquotedIdentifier: string): string => {
    return unquotedIdentifier.replace(/[^\w\d_]+/g, '')
}

export function upgradeRedshiftImport(
    response: PluginConfigVMInternalResponse<PluginMeta<RedshiftImportUpgrade>>
): void {
    const { methods, tasks, meta } = response

    const oldSetupPlugin = methods.setupPlugin
    methods.setupPlugin = async () => {
        console.log('IVE BEEN SETUP')

        const requiredConfigOptions = ['clusterHost', 'clusterPort', 'dbName', 'dbUsername', 'dbPassword']
        for (const option of requiredConfigOptions) {
            if (!(option in meta.config)) {
                throw new Error(`Required config option ${option} is missing!`)
            }
        }

        if (!meta.config.clusterHost.endsWith('redshift.amazonaws.com')) {
            throw new Error('Cluster host must be a valid AWS Redshift host')
        }

        const testQuery = await executeQuery('SELECT 1', [], meta)

        if (testQuery.error) {
            throw new Error('Unable to connect to Redshift!')
        }

        await oldSetupPlugin?.()

        const offset = await meta.storage.get('import_offset', 0)

        await meta.jobs.importAndIngestEvents({ offset, retriesPerformedSoFar: 0 }).runNow()
    }

    meta.global.importAndIngestEvents = async (
        payload: ImportEventsJobPayload,
        meta: PluginMeta<RedshiftImportUpgrade>
    ) => {
        if (payload.retriesPerformedSoFar >= 15) {
            console.error(
                `Import error: Unable to process rows ${payload.offset}-${payload.offset + 100}. Skipped them.`
            )
            return
        }

        const query = `SELECT * FROM $1 ORDER BY $2 OFFSET $3 LIMIT 100;`
        const values = [
            sanitizeSqlIdentifier(meta.config.tableName),
            sanitizeSqlIdentifier(meta.config.orderByColumn),
            payload.offset,
        ]

        const queryResponse = await executeQuery(query, values, meta)

        if (queryResponse.error || !queryResponse.queryResult) {
            const nextRetrySeconds = 2 ** payload.retriesPerformedSoFar * 3
            console.log(
                `Unable to process rows ${payload.offset}-${
                    payload.offset + 100
                }. Retrying in ${nextRetrySeconds}. Error: ${queryResponse.error}`
            )
            await meta.jobs
                .importAndIngestEvents({ ...payload, retriesPerformedSoFar: payload.retriesPerformedSoFar + 1 })
                .runIn(nextRetrySeconds, 'seconds')
        }

        const eventsToIngest = await methods.importEventsFromRedshift!(queryResponse.queryResult!)

        if (!Array.isArray(eventsToIngest)) {
            throw new Error('importEventsFromRedshift must return an array of plugin events')
        }

        console.log('OFFSET', payload.offset)
        for (const event of eventsToIngest) {
            console.log(event.event)
            posthog.capture(event.event, event.properties)
        }

        await meta.storage.set('import_offset', payload.offset + 100)
        await meta.jobs
            .importAndIngestEvents({ offset: payload.offset + 100, retriesPerformedSoFar: 0 })
            .runIn(10, 'seconds')
    }

    async function executeQuery(
        query: string,
        values: any[],
        meta: PluginMeta<RedshiftImportUpgrade>
    ): Promise<ExecuteQueryResponse> {
        const { config } = meta

        const pgClient = new Client({
            user: config.dbUsername,
            password: config.dbPassword,
            host: config.clusterHost,
            database: config.dbName,
            port: parseInt(config.clusterPort),
        })

        await pgClient.connect()

        let error: Error | null = null
        let queryResult: QueryResult<any> | null = null
        try {
            queryResult = await pgClient.query(query, values)
        } catch (err) {
            error = err
        }

        await pgClient.end()

        return { error, queryResult }
    }

    tasks.job['importAndIngestEvents'] = {
        name: 'importAndIngestEvents',
        type: PluginTaskType.Job,
        exec: (payload) => meta.global.importAndIngestEvents(payload as ImportEventsJobPayload, meta),
    }
}
