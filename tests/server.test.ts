import { startPluginsServer } from '../src/main/pluginsServer'
import { LogLevel } from '../src/types'
import { makePiscina } from '../src/worker/piscina'
import { pluginConfig39 } from './helpers/plugins'
import { getErrorForPluginConfig, resetTestDatabase } from './helpers/sql'

jest.mock('../src/shared/sql')
jest.setTimeout(60000) // 60 sec timeout

test('startPluginsServer', async () => {
    const testCode = `
        async function processEvent (event) {
            return event
        }
        async function teardownPlugin() {
            throw new Error('This Happened In The Teardown Palace')
        }
    `
    await resetTestDatabase(testCode)
    const pluginsServer = await startPluginsServer(
        {
            WORKER_CONCURRENCY: 2,
            LOG_LEVEL: LogLevel.Debug,
        },
        makePiscina
    )

    // no error before stopping
    const error1 = await getErrorForPluginConfig(pluginConfig39.id)
    expect(error1).toBe(null)

    await pluginsServer.stop()

    // verify the teardownPlugin code runs
    const error2 = await getErrorForPluginConfig(pluginConfig39.id)
    expect(error2.message).toBe('This Happened In The Teardown Palace')
})
