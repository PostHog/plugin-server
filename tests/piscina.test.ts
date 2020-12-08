import { defaultConfig } from '../src/server'
import { makePiscina } from '../src/worker/piscina'
import { PluginEvent } from 'posthog-plugins/src/types'
import { performance } from 'perf_hooks'
import { mockJestWithIndex } from './helpers/plugins'
import * as os from 'os'

jest.mock('../src/sql')
jest.setTimeout(300000) // 300 sec timeout

function processOneEvent(processEvent: (event: PluginEvent) => Promise<PluginEvent>, index: number): Promise<PluginEvent> {
    const defaultEvent = {
        distinct_id: 'my_id',
        ip: '127.0.0.1',
        site_url: 'http://localhost',
        team_id: 2,
        now: new Date().toISOString(),
        event: 'default event',
        properties: { key: 'value', index },
    }

    return processEvent(defaultEvent)
}

function processOneBatch(
    processEvents: (events: PluginEvent[]) => Promise<PluginEvent[]>,
    batchSize: number,
    batchIndex: number
): Promise<PluginEvent[]> {
    const events = [...Array(batchSize)].map((_, i) => ({
        distinct_id: 'my_id',
        ip: '127.0.0.1',
        site_url: 'http://localhost',
        team_id: 2,
        now: new Date().toISOString(),
        event: 'default event',
        properties: { key: 'value', batchIndex, indexInBatch: i },
    }))

    return processEvents(events)
}

async function processCountEvents(piscina: ReturnType<typeof makePiscina>, count: number, batchSize = 1) {
    const startTime = performance.now()
    const promises = Array(count)

    const processEvent = (event: PluginEvent) => piscina.runTask({ task: 'processEvent', args: { event } })
    const processEvents = (events: PluginEvent[]) => piscina.runTask({ task: 'processEvents', args: { events } })

    for (let i = 0; i < count; i++) {
        promises[i] = batchSize === 1 ? processOneEvent(processEvent, i) : processOneBatch(processEvents, batchSize, i)
    }
    // this will get heavy for tests > 10k events, should chunk them somehow...
    await Promise.all(promises)

    const ms = Math.round((performance.now() - startTime) * 1000) / 1000

    const log = {
        eventsPerSecond: 1000 / (ms / (count * batchSize)),
        events: count,
        concurrency: piscina.threads.length,
        totalMs: ms,
        averageEventMs: ms / count,
    }

    return log
}

function setupPiscina(workers: number) {
    return makePiscina({
        ...defaultConfig,
        WORKER_CONCURRENCY: workers,
        __jestMock: mockJestWithIndex(`
            function processEvent (event, meta) {
                let j = 0; for(let i = 0; i < 200000; i++) { j = i };
                event.properties = { "somewhere": "over the rainbow" }; 
                return event
            }

            function processEvents (events, meta) {
                return events.map(event => processEvent(event, meta))
            }
        `),
    })
}

test('piscina 2-24 workers', async () => {
    const cpuCount = os.cpus().length

    const workers = [1, 2, 4, 8, 12, 16, 24, 32, 48, 64].filter((cores) =>
        cpuCount === 2 ? cores <= cpuCount : cores < cpuCount
    )
    const events = 10000
    const rounds = 5

    const results: Record<number, number> = {}
    for (const cores of workers) {
        const piscina = setupPiscina(cores)

        // warmup
        await processCountEvents(piscina, cpuCount * 4, 1)

        // start
        let throughput = 0
        for (let i = 0; i < rounds; i++) {
            const { eventsPerSecond } = await processCountEvents(piscina, events, 1)
            throughput += eventsPerSecond
        }
        results[cores] = Math.round(throughput / rounds)
        await piscina.destroy()
    }

    console.log({ cpuCount })
    console.log(JSON.stringify(results, null, 2))

    // expect that adding more cores (up to cpuCount) increases throughput
    for (let i = 1; i < workers.length; i++) {
        expect(results[workers[i - 1]]).toBeLessThan(results[workers[i]])
    }
})

test('piscina 2-24 workers batch of 10', async () => {
    const cpuCount = os.cpus().length

    const workers = [1, 2, 4, 8, 12, 16, 24, 32, 48, 64].filter((cores) => cores < cpuCount)
    const events = 1000
    const batchSize = 10
    const rounds = 5

    const results: Record<number, number> = {}
    for (const cores of workers) {
        const piscina = setupPiscina(cores)

        // warmup
        await processCountEvents(piscina, cpuCount * 4, batchSize)

        // start
        let throughput = 0
        for (let i = 0; i < rounds; i++) {
            const { eventsPerSecond } = await processCountEvents(piscina, events, batchSize)
            throughput += eventsPerSecond
        }
        results[cores] = Math.round(throughput / rounds)
        await piscina.destroy()
    }

    console.log({ cpuCount })
    console.log(JSON.stringify(results, null, 2))

    // expect that adding more cores (up to cpuCount) increases throughput
    for (let i = 1; i < workers.length; i++) {
        expect(results[workers[i - 1]]).toBeLessThan(results[workers[i]])
    }
})

test('piscina 2-24 workers batch of 100', async () => {
    const cpuCount = os.cpus().length

    const workers = [1, 2, 4, 8, 12, 16, 24, 32, 48, 64].filter((cores) => cores < cpuCount)
    const events = 100
    const batchSize = 100
    const rounds = 5

    const results: Record<number, number> = {}
    for (const cores of workers) {
        const piscina = setupPiscina(cores)

        // warmup
        await processCountEvents(piscina, cpuCount * 4, batchSize)

        // start
        let throughput = 0
        for (let i = 0; i < rounds; i++) {
            const { eventsPerSecond } = await processCountEvents(piscina, events, batchSize)
            throughput += eventsPerSecond
        }
        results[cores] = Math.round(throughput / rounds)
        await piscina.destroy()
    }

    console.log({ cpuCount })
    console.log(JSON.stringify(results, null, 2))

    // expect that adding more cores (up to cpuCount) increases throughput
    for (let i = 1; i < workers.length; i++) {
        expect(results[workers[i - 1]]).toBeLessThan(results[workers[i]])
    }
})
