import { makeWorkerUtils, WorkerUtils } from 'graphile-worker'

import { startPluginsServer } from '../src/main/pluginsServer'
import { getDefaultConfig } from '../src/shared/config'
import { delay } from '../src/shared/utils'
import { LogLevel } from '../src/types'
import { makePiscina } from '../src/worker/piscina'
import { createPosthog } from '../src/worker/vm/extensions/posthog'
import { imports } from '../src/worker/vm/imports'
import { pluginConfig39 } from './helpers/plugins'
import { resetTestDatabase } from './helpers/sql'

jest.mock('../src/shared/sql')
jest.setTimeout(60000) // 60 sec timeout

const { console: testConsole } = imports['test-utils/write-to-file']

describe('retry queues', () => {
    let workerUtils: WorkerUtils

    beforeEach(async () => {
        testConsole.reset()
        workerUtils = await makeWorkerUtils({
            connectionString: getDefaultConfig().DATABASE_URL,
        })
    })

    afterEach(async () => {
        await workerUtils.release()
    })

    test('onRetry gets called', async () => {
        const testCode = `
            import { console } from 'test-utils/write-to-file'

            export async function onRetry (type, payload, meta) {
                console.log('retrying event!', type)
            }
            export async function processEvent (event, meta) {
                if (event.properties?.hi === 'ha') {
                    console.log('processEvent')
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

        posthog.capture('my event', { hi: 'ha' })
        await delay(5000)

        expect(testConsole.read()).toEqual([['processEvent'], ['retrying event!', 'processEvent']])

        await server.stop()
    })

    test('graphile retry queue', async () => {
        const testCode = `
            import { console } from 'test-utils/write-to-file'

            export async function onRetry (type, payload, meta) {
                console.log('retrying event!', type)
            }
            export async function processEvent (event, meta) {
                if (event.properties?.hi === 'ha') {
                    console.log('processEvent')
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
                RETRY_QUEUES: 'graphile',
            },
            makePiscina
        )
        const posthog = createPosthog(server.server, pluginConfig39)

        posthog.capture('my event', { hi: 'ha' })
        await delay(5000)

        expect(testConsole.read()).toEqual([['processEvent'], ['retrying event!', 'processEvent']])

        await server.stop()
    })
})
