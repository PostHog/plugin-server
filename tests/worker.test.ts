import { makePiscina } from '../src/worker/piscina'
import { defaultConfig } from '../src/config'
import { PluginEvent } from 'posthog-plugins/src/types'
import { performance } from 'perf_hooks'
import { mockJestWithIndex } from './helpers/plugins'
import * as os from 'os'
import { LogLevel, PluginsServerConfig } from '../src/types'

jest.mock('../src/sql')
jest.setTimeout(300000) // 300 sec timeout

function processOneEvent(processEvent: (event: PluginEvent) => Promise<PluginEvent>): Promise<PluginEvent> {
    const defaultEvent = {
        distinct_id: 'my_id',
        ip: '127.0.0.1',
        site_url: 'http://localhost',
        team_id: 2,
        now: new Date().toISOString(),
        event: 'default event',
        properties: { key: 'value' },
    }

    return processEvent(defaultEvent)
}

async function processCountEvents(count: number, piscina: ReturnType<typeof makePiscina>) {
    const maxPromises = 1000
    const startTime = performance.now()
    const promises = Array(maxPromises)
    const processEvent = (event: PluginEvent) => piscina.runTask({ task: 'processEvent', args: { event } })

    const groups = Math.ceil(count / maxPromises)
    for (let j = 0; j < groups; j++) {
        const groupCount = j === groups - 1 ? count % maxPromises : maxPromises
        for (let i = 0; i < groupCount; i++) {
            promises[i] = processOneEvent(processEvent)
        }
        await Promise.all(promises)
    }

    const ms = Math.round((performance.now() - startTime) * 1000) / 1000

    const log = {
        eventsPerSecond: 1000 / (ms / count),
        events: count,
        concurrency: piscina.threads.length,
        totalMs: ms,
        averageEventMs: ms / count,
    }

    return log
}

function setupPiscina(workers: number, code: string, tasksPerWorker: number) {
    return makePiscina({
        ...defaultConfig,
        WORKER_CONCURRENCY: workers,
        TASKS_PER_WORKER: tasksPerWorker,
        LOG_LEVEL: LogLevel.Log,
        __jestMock: mockJestWithIndex(code),
    } as PluginsServerConfig)
}

test('piscina worker test', async () => {
    const coreCount = os.cpus().length

    const workers = [1, 2, 4, 8, 12, 16].filter((cores) => cores <= coreCount)
    const rounds = 5

    const tests: { testName: string; events: number; testCode: string }[] = [
        {
            testName: 'simple',
            events: 10000,
            testCode: `
                function processEvent (event, meta) {
                    event.properties = { "somewhere": "over the rainbow" };
                    return event
                }
            `,
        },
        {
            testName: 'for200k',
            events: 10000,
            testCode: `
                function processEvent (event, meta) {
                    let j = 0; for(let i = 0; i < 200000; i++) { j = i };
                    event.properties = { "somewhere": "over the rainbow" };
                    return event
                }
            `,
        },
        {
            testName: 'timeout100ms',
            events: 2000,
            testCode: `
                async function processEvent (event, meta) {
                    await new Promise(resolve => __jestSetTimeout(() => resolve(), 100))
                    event.properties = { "somewhere": "over the rainbow" };
                    return event             
                }
            `,
        },
    ]

    const results: Array<Record<string, string | number>> = []
    for (const { testName, events, testCode } of tests) {
        const result: Record<string, any> = {
            testName,
            coreCount,
        }
        for (const cores of workers) {
            const piscina = setupPiscina(cores, testCode, 100)

            // warmup
            await processCountEvents(cores * 4, piscina)

            // start
            let throughput = 0
            for (let i = 0; i < rounds; i++) {
                const { eventsPerSecond } = await processCountEvents(events, piscina)
                throughput += eventsPerSecond
            }
            result[`${cores} cores`] = Math.round(throughput / rounds)
            await piscina.destroy()
        }
        results.push(result)
        console.log(JSON.stringify({ result }, null, 2))
    }
    console.table(results)
})
