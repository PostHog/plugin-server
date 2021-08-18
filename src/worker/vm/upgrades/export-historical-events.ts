import { Plugin, PluginMeta } from '@posthog/plugin-scaffold'
import { DateTime } from 'luxon'
import { Client } from 'pg'
import { castTimestampToClickhouseFormat, sanitizeSqlIdentifier } from 'utils/utils'

import {
    Event,
    Hub,
    MetricMathOperations,
    PluginConfig,
    PluginConfigVMInternalResponse,
    PluginLogEntrySource,
    PluginLogEntryType,
    PluginTaskType,
} from '../../../types'
import { DB } from '../../../utils/db/db'

interface TimestampBoundaries {
    min: Date
    max: Date
}

interface ExportEventsJobPayload extends Record<string, any> {
    // The lower bound of the timestamp interval to be processed
    timstampCursor?: number

    // The offset *within* a given timestamp interval
    intraIntervalOffset?: number

    // how many retries a payload has had (max = 15)
    retriesPerformedSoFar: number

    // tells us we're ready to pick up a new interval
    incrementTimestampCursor: boolean
}

type ExportEventsFromTheBeginningUpgrade = Plugin<{
    global: {
        pgClient: Client
        eventsToIgnore: Set<string>
        sanitizedTableName: string
        exportEventsFromTheBeginning: (
            payload: ExportEventsJobPayload,
            meta: PluginMeta<ExportEventsFromTheBeginningUpgrade>
        ) => Promise<void>
        initialTimestampCursor: number
        killSwitchOn: boolean
        timestampLimit: Date
    }
}>

const EVENTS_TIME_INTERVAL = 10 * 60 * 1000 // 10 minutes
const EVENTS_PER_RUN = 100
const TIMESTAMP_CURSOR_KEY = 'timestamp_cursor'
const UNFINISHED_INTERVALS_LIST_KEY = 'unfinished_intervals'
const RUNNING_INTERVALS_LIST_KEY = 'running_intervals'
const MAX_TIMESTAMP_KEY = 'max_timestamp'

const fetchTimestampBoundariesForTeam = async (db: DB, teamId: number): Promise<TimestampBoundaries> => {
    if (db.kafkaProducer) {
        const clickhouseFetchTimestampsResult = await db.clickhouseQuery(`
            SELECT min(_timestamp), max(_timestamp)
            FROM events
            WHERE team_id = ${teamId}`)

        return {
            min: new Date(clickhouseFetchTimestampsResult.data[0].min),
            max: new Date(clickhouseFetchTimestampsResult.data[0].max),
        }
    } else {
        const postgresFetchTimestampsResult = await db.postgresQuery(
            `SELECT min(timestamp), max(timestamp) FROM posthog_event WHERE team_id = $1`,
            [teamId],
            'fetchTimestampBoundariesForTeam'
        )

        return {
            min: new Date(postgresFetchTimestampsResult.rows[0].min),
            max: new Date(postgresFetchTimestampsResult.rows[0].max),
        }
    }
}

const fetchEventsForInterval = async (
    db: DB,
    teamId: number,
    timestampLowerBound: Date,
    offset: number
): Promise<Event[]> => {
    const timestampUpperBound = new Date(timestampLowerBound.getTime() + EVENTS_TIME_INTERVAL)

    if (db.kafkaProducer) {
        const chTimestampLower = castTimestampToClickhouseFormat(DateTime.fromISO(timestampLowerBound.toISOString()))
        const chTimestampHigher = castTimestampToClickhouseFormat(DateTime.fromISO(timestampUpperBound.toISOString()))

        const clickhouseFetchEventsResult = await db.clickhouseQuery(`
            SELECT * FROM events 
            WHERE team_id = ${teamId} 
            AND _timestamp >= ${sanitizeSqlIdentifier(chTimestampLower)} 
            AND _timestamp <= ${sanitizeSqlIdentifier(chTimestampHigher)} 
            ORDER BY _offset 
            LIMIT ${EVENTS_PER_RUN} 
            OFFSET ${offset}`)

        return clickhouseFetchEventsResult.data.map(
            ({ event, uuid, properties, team_id, distinct_id, elements_hash, timestamp, created_at }) => ({
                event,
                team_id,
                distinct_id,
                elements_hash,
                timestamp,
                created_at,
                properties: JSON.parse(properties),
                id: uuid,
            })
        )
    } else {
        const postgresFetchEventsResult = await db.postgresQuery(
            `SELECT * FROM posthog_event WHERE team_id = $1 AND timestamp >= $2 AND timestamp <= $3 ORDER BY id LIMIT $4 OFFSET $5`,
            [teamId, timestampLowerBound.toISOString(), timestampUpperBound.toISOString(), EVENTS_PER_RUN, offset],
            'fetchEventsForInterval'
        )

        return postgresFetchEventsResult.rows
    }
}

export function upgradeExportEventsFromTheBeginning(
    hub: Hub,
    pluginConfig: PluginConfig,
    response: PluginConfigVMInternalResponse<PluginMeta<ExportEventsFromTheBeginningUpgrade>>
): void {
    const { methods, tasks, meta } = response

    const oldSetupPlugin = methods.setupPlugin
    const oldTeardownPlugin = methods.teardownPlugin

    methods.setupPlugin = async () => {
        const timestampBoundaries = await fetchTimestampBoundariesForTeam(hub.db, pluginConfig.team_id)

        const storedTimestampLimit = await meta.storage.get(MAX_TIMESTAMP_KEY, null)
        if (storedTimestampLimit) {
            meta.global.timestampLimit = new Date(String(storedTimestampLimit))
        } else {
            await meta.storage.set(MAX_TIMESTAMP_KEY, timestampBoundaries.max.toISOString())
            meta.global.timestampLimit = timestampBoundaries.max
        }

        // used for picking up where we left off after a restart
        const lastStoredTimestampCursor = await meta.storage.get(TIMESTAMP_CURSOR_KEY, 0)
        meta.global.initialTimestampCursor = timestampBoundaries.min.getTime()

        const redisTimestampCursor = await meta.cache.get(TIMESTAMP_CURSOR_KEY, null)
        if (!redisTimestampCursor) {
            await meta.cache.set(TIMESTAMP_CURSOR_KEY, Number(lastStoredTimestampCursor) / EVENTS_TIME_INTERVAL)
        }

        // re-export intervals that didn't finish because of e.g. a plugin server restart
        const storedPendingIntervals = await meta.storage.get(UNFINISHED_INTERVALS_LIST_KEY, null)
        const cachedPendingIntervalsLength = await meta.cache.llen(UNFINISHED_INTERVALS_LIST_KEY)
        if (storedPendingIntervals && !cachedPendingIntervalsLength) {
            await meta.cache.lpush(UNFINISHED_INTERVALS_LIST_KEY, String(storedPendingIntervals).split(','))
        }

        await oldSetupPlugin?.()

        await meta.jobs
            .exportEventsFromTheBeginning({ retriesPerformedSoFar: 0, incrementTimestampCursor: true })
            .runIn(10, 'seconds')
    }

    meta.global.exportEventsFromTheBeginning = async (
        payload: ExportEventsJobPayload,
        meta: PluginMeta<ExportEventsFromTheBeginningUpgrade>
    ) => {
        if (payload.retriesPerformedSoFar >= 15) {
            // create some log error here
            return
        }

        let timestampCursor = payload.timestampCursor
        let intraIntervalOffset = payload.intraIntervalOffset ?? 0

        // This is the first run OR we're done with an interval
        if (payload.incrementTimestampCursor) {
            // done with a timestamp interval, reset offset
            intraIntervalOffset = 0

            // Done with an interval, remove interval from pending list
            if (timestampCursor) {
                await meta.cache.lrem(RUNNING_INTERVALS_LIST_KEY, 1, timestampCursor.toString())
            }

            // Always check for any pending intervals before picking up a completely new one
            const nextPendingInterval = await meta.cache.lpop(UNFINISHED_INTERVALS_LIST_KEY, 1)
            if (nextPendingInterval && nextPendingInterval.length > 0) {
                timestampCursor = Number(nextPendingInterval[0])
            } else {
                const redisIncrementedCursor = await meta.cache.incr(TIMESTAMP_CURSOR_KEY)
                //createLog(`${meta.global.initialTimestampCursor} /// ${redisIncrementedCursor} ${EVENTS_TIME_INTERVAL}`)
                timestampCursor =
                    meta.global.initialTimestampCursor + (redisIncrementedCursor - 1) * EVENTS_TIME_INTERVAL

                // keep storage up-to-date with up to where we've processed so far
                await meta.storage.set(TIMESTAMP_CURSOR_KEY, timestampCursor)
            }

            await meta.cache.lpush(RUNNING_INTERVALS_LIST_KEY, [timestampCursor.toString()])
        }

        if (timestampCursor > meta.global.timestampLimit.getTime()) {
            createLog(`Done exporting all events`)
            return
        }

        createLog(`${timestampCursor} /// ${intraIntervalOffset}`)
        let events: Event[] = []
        try {
            // createLog(`${new Date(timestampCursor).toISOString()} /// ${intraIntervalOffset}`)
            events = await fetchEventsForInterval(
                hub.db,
                pluginConfig.team_id,
                new Date(timestampCursor),
                intraIntervalOffset
            )
        } catch (error) {
            // createLog(`RETRY ${new Date(timestampCursor).toISOString()} /// ${intraIntervalOffset}`)

            // some log here too
            const nextRetrySeconds = 2 ** payload.retriesPerformedSoFar * 3
            await meta.jobs
                .exportEventsFromTheBeginning({
                    intraIntervalOffset,
                    timestampCursor,
                    retriesPerformedSoFar: payload.retriesPerformedSoFar + 1,
                })
                .runIn(nextRetrySeconds, 'seconds')
        }

        await methods.exportEventsFromTheBeginning!(events)

        const incrementTimestampCursor = events.length === 0

        incrementMetric('events_exported', events.length)
        await meta.jobs
            .exportEventsFromTheBeginning({
                timestampCursor,
                incrementTimestampCursor,
                retriesPerformedSoFar: 0,
                intraIntervalOffset: intraIntervalOffset + EVENTS_PER_RUN,
            })
            .runNow()
    }

    methods.teardownPlugin = async () => {
        // Check if there are any intervals we didn't finish processing
        const runningIntervalsLength = await meta.cache.llen(RUNNING_INTERVALS_LIST_KEY)
        const runningIntervals = await meta.cache.lrange(RUNNING_INTERVALS_LIST_KEY, 0, runningIntervalsLength)

        // Check if there are any intervals that failed before and we still didn't get to
        const rolledOverIntervalsLength = await meta.cache.llen(UNFINISHED_INTERVALS_LIST_KEY)
        const rolledOverIntervals = await meta.cache.lrange(UNFINISHED_INTERVALS_LIST_KEY, 0, rolledOverIntervalsLength)

        // All intervals we still didn't process
        const allPendingIntervals = [...runningIntervals, ...rolledOverIntervals]

        if (allPendingIntervals.length > 0) {
            await meta.storage.set(UNFINISHED_INTERVALS_LIST_KEY, allPendingIntervals.join(','))
        }

        await meta.cache.expire(UNFINISHED_INTERVALS_LIST_KEY, 0)
        await meta.cache.expire(RUNNING_INTERVALS_LIST_KEY, 0)

        await oldTeardownPlugin?.()
    }

    tasks.job['exportEventsFromTheBeginning'] = {
        name: 'exportEventsFromTheBeginning',
        type: PluginTaskType.Job,
        exec: (payload) => meta.global.exportEventsFromTheBeginning(payload as ExportEventsJobPayload, meta),
    }

    function incrementMetric(metricName: string, value: number) {
        hub.pluginMetricsManager.updateMetric({
            metricName,
            value,
            pluginConfig,
            metricOperation: MetricMathOperations.Increment,
        })
    }

    function createLog(message: string, type: PluginLogEntryType = PluginLogEntryType.Log) {
        void hub.db.queuePluginLogEntry({
            pluginConfig,
            message: `(${hub.instanceId}) ${message}`,
            source: PluginLogEntrySource.System,
            type: type,
            instanceId: hub.instanceId,
        })
    }
}
