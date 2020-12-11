import { setupPiscina } from './helpers/worker'
import { createServer, runTasksDebounced, waitForTasksToFinish } from '../src/server'
import { LogLevel } from '../src/types'
import { delay } from '../src/utils'
import { PluginEvent } from 'posthog-plugins/src/types'

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

test('runTasksDebounced', async () => {
    const workerThreads = 2
    const testCode = `
        const counterKey = 'test_counter_2'
        async function setupPlugin (meta) {
            await meta.cache.set(counterKey, 0)
        } 
        async function processEvent (event, meta) {
            event.properties['counter'] = await meta.cache.get(counterKey)
            return event 
        }
        async function runEveryMinute (meta) {
            // stall for a second
            await new Promise(resolve => __jestSetTimeout(resolve, 500))
            await meta.cache.incr(counterKey)
        }
    `
    const piscina = setupPiscina(workerThreads, testCode, 10)

    const getPluginSchedule = () => piscina.runTask({ task: 'getPluginSchedule' })
    const processEvent = (event: PluginEvent) => piscina.runTask({ task: 'processEvent', args: { event } })

    const [server] = await createServer({ LOG_LEVEL: LogLevel.Log })
    server.pluginSchedule = await getPluginSchedule()
    expect(server.pluginSchedule).toEqual({ runEveryDay: [], runEveryHour: [], runEveryMinute: [39] })

    const event1 = await processEvent(createEvent())
    expect(event1.properties['counter']).toBe(0)

    runTasksDebounced(server, piscina, 'runEveryMinute')
    runTasksDebounced(server, piscina, 'runEveryMinute')
    runTasksDebounced(server, piscina, 'runEveryMinute')
    await delay(100)

    const event2 = await processEvent(createEvent())
    expect(event2.properties['counter']).toBe(0)

    await delay(500)

    const event3 = await processEvent(createEvent())
    expect(event3.properties['counter']).toBe(1)

    await piscina.destroy()
    await waitForTasksToFinish(server)
})
