import { createBuffer } from '@posthog/plugin-contrib'
import { ConsoleExtension, Plugin, PluginEvent, PluginMeta, RetryError } from '@posthog/plugin-scaffold'

import { PluginConfigVMInternalResponse, PluginTaskType } from '../../../types'

type ExportEventsUpgrade = Plugin<{
    global: {
        exportEventsBuffer: ReturnType<typeof createBuffer>
        exportEventsToIgnore: Set<string>
        exportEventsWithRetry: (payload: ExportEventsJobPayload, meta: PluginMeta<ExportEventsUpgrade>) => Promise<void>
    }
    config: {
        exportEventsBufferBytes: string
        exportEventsBufferSeconds: string
        exportEventsToIgnore: string
    }
    jobs: {
        exportEventsWithRetry: ExportEventsJobPayload
    }
}>

interface ExportEventsJobPayload extends Record<string, any> {
    batch: PluginEvent[]
    batchId: number
    retriesPerformedSoFar: number
}

/*
 This function injects code into a plugin VM that has exported `exportEvents`:
 - add the global/config/jobs specified in the `ExportEventsUpgrade` type above.
 - patch `onEvent` with code to add the event to a buffer.
 */
export function upgradeExportEvents(
    response: PluginConfigVMInternalResponse<PluginMeta<ExportEventsUpgrade>>,
    console: ConsoleExtension
): void {
    const { methods, tasks, meta } = response

    if (!methods.exportEvents) {
        return
    }

    const nanToNull = (nr: any): null | number => (isNaN(parseInt(nr)) ? null : parseInt(nr))
    const uploadBytes = Math.max(
        1,
        Math.min(nanToNull(meta.config.exportEventsBufferBytes) ?? 1024 * 1024, 100 * 1024 * 1024)
    )
    const uploadSeconds = Math.max(1, Math.min(nanToNull(meta.config.exportEventsBufferSeconds) ?? 10, 600))

    meta.global.exportEventsToIgnore = new Set(
        meta.config.exportEventsToIgnore
            ? meta.config.exportEventsToIgnore.split(',').map((event: string) => event.trim())
            : null
    )

    meta.global.exportEventsBuffer = createBuffer({
        limit: uploadBytes,
        timeoutSeconds: uploadSeconds,
        onFlush: async (batch) => {
            const jobPayload = {
                batch,
                batchId: Math.floor(Math.random() * 1000000),
                retriesPerformedSoFar: 0,
            }
            const firstThroughQueue = false // TODO: might make sense sometimes? e.g. when we are processing too many tasks already?
            if (firstThroughQueue) {
                await meta.jobs.exportEventsWithRetry(jobPayload).runNow()
            } else {
                await meta.global.exportEventsWithRetry(jobPayload, meta)
            }
        },
    })

    meta.global.exportEventsWithRetry = async (
        payload: ExportEventsJobPayload,
        meta: PluginMeta<ExportEventsUpgrade>
    ) => {
        try {
            await methods.exportEvents(payload.batch)
        } catch (err) {
            if (err instanceof RetryError) {
                if (payload.retriesPerformedSoFar < 15) {
                    const nextRetrySeconds = 2 ** payload.retriesPerformedSoFar * 3
                    console.log(`Enqueued batch ${payload.batchId} for retry in ${Math.round(nextRetrySeconds)}s`)

                    await meta.jobs
                        .exportEventsWithRetry({ ...payload, retriesPerformedSoFar: payload.retriesPerformedSoFar + 1 })
                        .runIn(nextRetrySeconds, 'seconds')
                } else {
                    console.log(
                        `Dropped batch ${payload.batchId} after retrying ${payload.retriesPerformedSoFar} times`
                    )
                }
            } else {
                throw err
            }
        }
    }

    tasks.job['exportEventsWithRetry'] = {
        name: 'exportEventsWithRetry',
        type: PluginTaskType.Job,
        exec: (payload) => meta.global.exportEventsWithRetry(payload as ExportEventsJobPayload, meta),
    }

    const oldOnEvent = methods.onEvent
    methods.onEvent = async (event) => {
        if (!meta.global.exportEventsToIgnore.has(event.event)) {
            meta.global.exportEventsBuffer.add(event, JSON.stringify(event).length)
        }
        await oldOnEvent?.(event)
    }
}
