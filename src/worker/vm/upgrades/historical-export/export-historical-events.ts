import { PluginMeta, RetryError } from '@posthog/plugin-scaffold'

import {
    Event,
    Hub,
    MetricMathOperations,
    PluginConfig,
    PluginConfigVMInternalResponse,
    PluginLogEntrySource,
    PluginLogEntryType,
    PluginTaskType,
} from '../../../../types'
import {
    ExportEventsFromTheBeginningUpgrade,
    ExportEventsJobPayload,
    fetchEventsForInterval,
    fetchTimestampBoundariesForTeam,
} from './utils'

const EVENTS_TIME_INTERVAL = 10 * 60 * 1000 // 10 minutes
const EVENTS_PER_RUN = 100
const TIMESTAMP_CURSOR_KEY = 'timestamp_cursor'
const MAX_TIMESTAMP_KEY = 'max_timestamp'

export function upgradeExportEventsFromTheBeginning(
    hub: Hub,
    pluginConfig: PluginConfig,
    response: PluginConfigVMInternalResponse<PluginMeta<ExportEventsFromTheBeginningUpgrade>>
): void {
    const { methods, tasks, meta } = response

    const oldSetupPlugin = methods.setupPlugin

    methods.setupPlugin = async () => {
        // Fetch the max and min timestamps for a team's events
        const timestampBoundaries = await fetchTimestampBoundariesForTeam(hub.db, pluginConfig.team_id)

        // Set the max limit if we haven't already.
        // We don't update this because the export plugin would have already
        // started exporting *new* events so we should only export *historical* ones.
        const storedTimestampLimit = await meta.storage.get(MAX_TIMESTAMP_KEY, null)
        if (storedTimestampLimit) {
            meta.global.timestampLimit = new Date(String(storedTimestampLimit))
        } else {
            await meta.storage.set(MAX_TIMESTAMP_KEY, timestampBoundaries.max.toISOString())
            meta.global.timestampLimit = timestampBoundaries.max
        }

        // Set the lower timestamp boundary to start from.
        // This will be 0 on the first run, but can be > 0 on a server restart
        // We also set this is Redis so we can leverage INCR to allocate work to threads
        // without duplication
        meta.global.initialTimestampCursor = timestampBoundaries.min.getTime()
        const lastStoredTimestampCursor = await meta.storage.get(TIMESTAMP_CURSOR_KEY, 0)
        const redisTimestampCursor = await meta.cache.get(TIMESTAMP_CURSOR_KEY, null)
        if (!redisTimestampCursor) {
            await meta.cache.set(TIMESTAMP_CURSOR_KEY, Number(lastStoredTimestampCursor) / EVENTS_TIME_INTERVAL)
        }

        await oldSetupPlugin?.()

        // This will become an interface trigger
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
            // Done with a timestamp interval, reset offset
            intraIntervalOffset = 0

            // This ensures we never process an interval twice
            const redisIncrementedCursor = await meta.cache.incr(TIMESTAMP_CURSOR_KEY)
            timestampCursor = meta.global.initialTimestampCursor + (redisIncrementedCursor - 1) * EVENTS_TIME_INTERVAL

            // keep storage up-to-date with up to where we've processed so far
            await meta.storage.set(TIMESTAMP_CURSOR_KEY, timestampCursor)
        }

        if (timestampCursor > meta.global.timestampLimit.getTime()) {
            createLog(`Done exporting all events`)
            return
        }

        let events: Event[] = []

        let fetchEventsError: Error | null = null
        try {
            events = await fetchEventsForInterval(
                hub.db,
                pluginConfig.team_id,
                new Date(timestampCursor),
                intraIntervalOffset,
                EVENTS_TIME_INTERVAL,
                EVENTS_PER_RUN
            )
        } catch (error) {
            fetchEventsError = error
        }

        let exportEventsError: Error | null = null

        if (!fetchEventsError) {
            try {
                await methods.exportEventsFromTheBeginning!(events)
            } catch (error) {
                exportEventsError = error
            }
        }

        // Retry on every error from "our side" but only on a RetryError from the plugin dev
        if (fetchEventsError || exportEventsError instanceof RetryError) {
            const nextRetrySeconds = 2 ** payload.retriesPerformedSoFar * 3

            // "Failed processing events 0-100 from 2021-08-19T12:34:26.061Z to 2021-08-19T12:44:26.061Z. Retrying in 3s"
            createLog(
                `Failed processing events ${intraIntervalOffset}-${
                    intraIntervalOffset + EVENTS_PER_RUN
                } from ${new Date(timestampCursor).toISOString()} to ${new Date(
                    timestampCursor + EVENTS_TIME_INTERVAL
                ).toISOString()}. Retrying in ${nextRetrySeconds}s`
            )

            await meta.jobs
                .exportEventsFromTheBeginning({
                    intraIntervalOffset,
                    timestampCursor,
                    retriesPerformedSoFar: payload.retriesPerformedSoFar + 1,
                })
                .runIn(nextRetrySeconds, 'seconds')
        }

        createLog(
            `Successfully processed events ${intraIntervalOffset}-${
                intraIntervalOffset + EVENTS_PER_RUN
            } from ${new Date(timestampCursor).toISOString()} to ${new Date(
                timestampCursor + EVENTS_TIME_INTERVAL
            ).toISOString()}.`
        )

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
