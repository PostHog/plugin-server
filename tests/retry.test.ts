import * as fetch from 'node-fetch'

import { startPluginsServer } from '../src/main/pluginsServer'
import { delay } from '../src/shared/utils'
import { LogLevel } from '../src/types'
import { makePiscina } from '../src/worker/piscina'
import { createPosthog } from '../src/worker/vm/extensions/posthog'
import { pluginConfig39 } from './helpers/plugins'
import { resetTestDatabase } from './helpers/sql'

jest.mock('../src/shared/sql')
jest.setTimeout(60000) // 60 sec timeout

describe('retry queues', () => {
    test('on retry gets called', async () => {
        const testCode = `
            import fetch from 'node-fetch'

            export async function onRetry (type, payload, meta) {
                if (type === 'processEvent') {
                    console.log('retrying event!', type)
                }
                void fetch('https://google.com/retry.json?query=' + type)
            }
            export async function processEvent (event, meta) {
                if (event.properties?.hi === 'ha') {
                    meta.retry('processEvent', event, 1)
                }
                return event
            }
        `
        await resetTestDatabase(testCode)
        const server = await startPluginsServer(
            {
                WORKER_CONCURRENCY: 2,
                LOG_LEVEL: LogLevel.Debug,
                RETRY_QUEUES: 'fs',
            },
            makePiscina
        )
        const posthog = createPosthog(server.server, pluginConfig39)

        expect(fetch).not.toHaveBeenCalled()

        posthog.capture('my event', { hi: 'ha' })
        await delay(5000)

        // can't use this as the call is in a different thread
        // expect(fetch).toHaveBeenCalledWith('https://google.com/retry.json?query=processEvent')

        await server.stop()
    })
})
