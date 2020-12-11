import { setupPiscina } from './helpers/worker'
import { createServer, runTasksDebounced } from '../src/server'
import { LogLevel } from '../src/types'
import { delay } from '../src/utils'

test('runTasksDebounced', async () => {
    const workerThreads = 2
    const testCode = `
        async function setupPlugin (meta) {
            console.log('setting up')
            await meta.cache.set('test_counter_2', 0)
        } 
        async function runEveryMinute (meta) {
            console.log('!!!')
            console.log(meta)
            const counter = await meta.cache.get('test_counter_2', 0)
            console.log('!!!')
            await new Promise(resolve => __setSetTimeout(resolve, 1000))
            console.log('!!!')
            await meta.cache.set('test_counter_2', counter + 1)
            console.log('!!!')
        } 
    `
    const piscina = setupPiscina(workerThreads, testCode, 10)

    const runEveryDay = (pluginConfigId: number) =>
        piscina.runTask({ task: 'tasks.runEveryDay', args: { pluginConfigId } })
    const getPluginSchedule = () => piscina.runTask({ task: 'getPluginSchedule' })

    const [server] = await createServer({ LOG_LEVEL: LogLevel.Log })
    server.pluginSchedule = await getPluginSchedule()
    expect(server.pluginSchedule).toEqual({ runEveryDay: [], runEveryHour: [], runEveryMinute: [39] })

    // await delay(100)

    runTasksDebounced(server, piscina, 'runEveryMinute')
    await delay(100)
    expect(await server.redis.get('test_counter_2')).toEqual(0)
    await delay(1000)
    expect(await server.redis.get('test_counter_2')).toEqual(1)

    await piscina.destroy()
})
