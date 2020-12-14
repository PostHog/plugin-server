import { PluginEvent } from 'posthog-plugins/src/types'
import { setupPiscina } from './helpers/worker'
import { delay } from '../src/utils'

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

test('piscina worker test', async () => {
    const workerThreads = 2
    const testCode = `
        function processEvent (event, meta) {
            event.properties["somewhere"] = "over the rainbow";
            return event
        }
        async function runEveryDay (meta) {
            return 4
        } 
    `
    const piscina = setupPiscina(workerThreads, testCode, 10)

    const processEvent = (event: PluginEvent) => piscina.runTask({ task: 'processEvent', args: { event } })
    const processEventBatch = (batch: PluginEvent[]) => piscina.runTask({ task: 'processEventBatch', args: { batch } })
    const runEveryDay = (pluginConfigId: number) => piscina.runTask({ task: 'runEveryDay', args: { pluginConfigId } })
    const getPluginSchedule = () => piscina.runTask({ task: 'getPluginSchedule' })

    const pluginSchedule = await getPluginSchedule()
    expect(pluginSchedule).toEqual({ runEveryDay: [39], runEveryHour: [], runEveryMinute: [] })

    const event = await processEvent(createEvent())
    expect(event.properties['somewhere']).toBe('over the rainbow')

    const eventBatch = await processEventBatch([createEvent()])
    expect(eventBatch[0]!.properties['somewhere']).toBe('over the rainbow')

    const everyDayReturn = await runEveryDay(39)
    expect(everyDayReturn).toBe(4)

    await piscina.destroy()
})

test('scheduled task test', async () => {
    const workerThreads = 2
    const testCode = `
        function processEvent (event, meta) {
            event.properties["somewhere"] = "over the rainbow";
            return event
        }
        async function runEveryDay (meta) {
            return 4
        } 
    `
    const piscina = setupPiscina(workerThreads, testCode, 10)

    const processEvent = (event: PluginEvent) => piscina.runTask({ task: 'processEvent', args: { event } })
    const processEventBatch = (batch: PluginEvent[]) => piscina.runTask({ task: 'processEventBatch', args: { batch } })
    const runEveryDay = (pluginConfigId: number) => piscina.runTask({ task: 'runEveryDay', args: { pluginConfigId } })
    const getPluginSchedule = () => piscina.runTask({ task: 'getPluginSchedule' })

    const pluginSchedule = await getPluginSchedule()
    expect(pluginSchedule).toEqual({ runEveryDay: [39], runEveryHour: [], runEveryMinute: [] })

    const event = await processEvent(createEvent())
    expect(event.properties['somewhere']).toBe('over the rainbow')

    const eventBatch = await processEventBatch([createEvent()])
    expect(eventBatch[0]!.properties['somewhere']).toBe('over the rainbow')

    const everyDayReturn = await runEveryDay(39)
    expect(everyDayReturn).toBe(4)

    await piscina.destroy()
})

test('assume that the workerThreads and tasksPerWorker values behave as expected', async () => {
    const workerThreads = 2
    const tasksPerWorker = 3
    const testCode = `
        async function processEvent (event, meta) {
            await new Promise(resolve => __jestSetTimeout(resolve, 300))
            return event
        }
    `
    const piscina = setupPiscina(workerThreads, testCode, tasksPerWorker)
    const processEvent = (event: PluginEvent) => piscina.runTask({ task: 'processEvent', args: { event } })
    const promises = []

    // warmup 2x
    await Promise.all([processEvent(createEvent()), processEvent(createEvent())])

    // process 10 events in parallel and ignore the result
    for (let i = 0; i < 10; i++) {
        promises.push(processEvent(createEvent()))
    }
    await delay(100)
    expect(piscina.queueSize).toBe(10 - workerThreads * tasksPerWorker)
    expect(piscina.completed).toBe(0 + 2)
    await delay(300)
    expect(piscina.queueSize).toBe(0)
    expect(piscina.completed).toBe(workerThreads * tasksPerWorker + 2)
    await delay(300)
    expect(piscina.queueSize).toBe(0)
    expect(piscina.completed).toBe(10 + 2)

    await piscina.destroy()
})

test('assume that the workerThreads and tasksPerWorker values behave as expected', async () => {
    const workerThreads = 2
    const tasksPerWorker = 3
    const testCode = `
        async function processEvent (event, meta) {
            await new Promise(resolve => __jestSetTimeout(resolve, 300))
            return event
        }
    `
    const piscina = setupPiscina(workerThreads, testCode, tasksPerWorker)
    const processEvent = (event: PluginEvent) => piscina.runTask({ task: 'processEvent', args: { event } })
    const promises = []

    // warmup 2x
    await Promise.all([processEvent(createEvent()), processEvent(createEvent())])

    // process 10 events in parallel and ignore the result
    for (let i = 0; i < 10; i++) {
        promises.push(processEvent(createEvent()))
    }
    await delay(100)
    expect(piscina.queueSize).toBe(10 - workerThreads * tasksPerWorker)
    expect(piscina.completed).toBe(0 + 2)
    await delay(300)
    expect(piscina.queueSize).toBe(0)
    expect(piscina.completed).toBe(workerThreads * tasksPerWorker + 2)
    await delay(300)
    expect(piscina.queueSize).toBe(0)
    expect(piscina.completed).toBe(10 + 2)

    await piscina.destroy()
})
