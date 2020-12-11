import { makePiscina } from '../src/worker/piscina'
import { defaultConfig } from '../src/config'
import { PluginEvent } from 'posthog-plugins/src/types'
import { mockJestWithIndex } from './helpers/plugins'
import { LogLevel } from '../src/types'

jest.mock('../src/sql')
jest.setTimeout(600000) // 600 sec timeout

function createEvent(index = 0): PluginEvent {
    return {
        distinct_id: 'my_id',
        ip: '127.0.0.1',
        site_url: 'http://localhost',
        team_id: 2,
        now: new Date().toISOString(),
        event: 'default event',
        properties: { key: 'value', index },
    }
}

function setupPiscina(workers: number, code: string, tasksPerWorker: number) {
    return makePiscina({
        ...defaultConfig,
        WORKER_CONCURRENCY: workers,
        TASKS_PER_WORKER: tasksPerWorker,
        LOG_LEVEL: LogLevel.Log,
        __jestMock: mockJestWithIndex(code),
    })
}

test('piscina worker test', async () => {
    const workerThreads = 2
    const testCode = `
        function processEvent (event, meta) {
            event.properties["somewhere"] = "over the rainbow";
            return event
        }
        async function runEveryDay (meta) {
            console.log('ran daily!')
            return 4
        } 
    `
    const piscina = setupPiscina(workerThreads, testCode, 10)

    const processEvent = (event: PluginEvent) => piscina.runTask({ task: 'processEvent', args: { event } })
    const processEventBatch = (batch: PluginEvent[]) => piscina.runTask({ task: 'processEventBatch', args: { batch } })
    const runEveryDay = () => piscina.runTask({ task: 'tasks.runEveryDay', args: { pluginConfigId: 39 } })

    const event = await processEvent(createEvent())
    expect(event.properties['somewhere']).toBe('over the rainbow')

    const eventBatch = await processEventBatch([createEvent()])
    expect(eventBatch[0]!.properties['somewhere']).toBe('over the rainbow')

    const everyDayReturn = await runEveryDay()
    expect(everyDayReturn).toBe(4)

    await piscina.destroy()
})
