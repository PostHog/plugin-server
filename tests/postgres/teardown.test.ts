import { startPluginsServer } from '../../src/main/pluginsServer'
import { delay } from '../../src/shared/utils'
import { LogLevel } from '../../src/types'
import { makePiscina } from '../../src/worker/piscina'
import { pluginConfig39 } from '../helpers/plugins'
import { getErrorForPluginConfig, resetTestDatabase } from '../helpers/sql'

jest.mock('../../src/shared/status')
jest.setTimeout(60000) // 60 sec timeout

describe('teardown', () => {
    test('teardown code runs when stopping', async () => {
        await resetTestDatabase(`
            async function processEvent (event) {
                event.properties.processed = 'hell yes'
                event.properties.upperUuid = event.properties.uuid?.toUpperCase()
                return event
            }
            async function teardownPlugin() {
                throw new Error('This Happened In The Teardown Palace')
            }
        `)
        const { stop } = await startPluginsServer(
            {
                WORKER_CONCURRENCY: 2,
                LOG_LEVEL: LogLevel.Log,
                KAFKA_ENABLED: false,
            },
            makePiscina
        )

        const error1 = await getErrorForPluginConfig(pluginConfig39.id)
        expect(error1).toBe(null)

        await stop()

        // verify the teardownPlugin code runs
        const error2 = await getErrorForPluginConfig(pluginConfig39.id)
        expect(error2.message).toBe('This Happened In The Teardown Palace')
    })

    test('teardown code runs when reloading', async () => {
        await resetTestDatabase(`
            async function processEvent (event) {
                event.properties.processed = 'hell yes'
                return event
            }
            async function teardownPlugin() {
                throw new Error('This Happened In The Teardown Palace')
            }
        `)
        const { piscina, stop, server } = await startPluginsServer(
            {
                WORKER_CONCURRENCY: 2,
                LOG_LEVEL: LogLevel.Log,
                KAFKA_ENABLED: false,
            },
            makePiscina
        )

        const error1 = await getErrorForPluginConfig(pluginConfig39.id)
        expect(error1).toBe(null)

        await delay(100)

        await server.db.postgresQuery('update posthog_pluginconfig set updated_at = now() where id = $1', [
            pluginConfig39.id,
        ])
        await piscina!.broadcastTask({ task: 'reloadPlugins' })

        // this teardown will happen async. wait up to 30sec for it...
        for (let i = 0; i < 30; i++) {
            await delay(1000)
            if ((await getErrorForPluginConfig(pluginConfig39.id))?.message) {
                break
            }
        }

        // verify the teardownPlugin code runs
        const error2 = await getErrorForPluginConfig(pluginConfig39.id)
        expect(error2.message).toBe('This Happened In The Teardown Palace')

        await stop()
    })
})
