import { createBuffer } from '@posthog/plugin-contrib'
import { Plugin, PluginEvent, PluginMeta } from '@posthog/plugin-scaffold'
import { VM } from 'vm2'

import { PluginConfigVMUpgrade } from '../../../types'
class RetryError extends Error {}

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

interface ExportEventsJobPayload {
    batch: PluginEvent[]
    batchId: number
    retriesPerformedSoFar: number
}

export function upgradeExportEvents(vm: VM, responseVar: string): void {
    const { methods, tasks, meta } = vm.run(responseVar) as PluginConfigVMUpgrade<PluginMeta<ExportEventsUpgrade>>

    if (!methods.exportEvents) {
        throw new Error('VM does not expose method "exportEvents"')
    }

    const uploadBytes = Math.max(1, Math.min(parseInt(meta.config.exportEventsBufferBytes) || 1024 * 1024, 100))
    const uploadSeconds = Math.max(1, Math.min(parseInt(meta.config.exportEventsBufferSeconds) || 30, 600))

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

    // Add "exportEventsWithRetry" job
    vm.run(`(function ({ name, job }) {
        ${responseVar}.__tasks.job[name] = { name, type: 'job', task: job }
    })`)({
        name: 'exportEventsWithRetry',
        job: (payload: ExportEventsJobPayload) => meta.global.exportEventsWithRetry(payload, meta),
    })

    // Patch onEvent
    vm.run(`(function (onEvent) {
        const oldOnEvent = ${responseVar}.__methods.onEvent;
        ${responseVar}.__methods.onEvent = async (event) => { await oldOnEvent?.(event); await onEvent?.(event); }
    })`)((event: PluginEvent) => {
        if (!meta.global.exportEventsToIgnore.has(event.event)) {
            meta.global.exportEventsBuffer.add(event)
        }
    })
}
