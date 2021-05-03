import { LOCKED_RESOURCE } from '../src/main/job-queues/job-queue-consumer'
import { ServerInstance, startPluginsServer } from '../src/main/pluginsServer'
import { LogLevel } from '../src/types'
import { createServer } from '../src/utils/db/server'
import { delay } from '../src/utils/utils'
import { makePiscina } from '../src/worker/piscina'
import { createPosthog, DummyPostHog } from '../src/worker/vm/extensions/posthog'
import { imports } from '../src/worker/vm/imports'
import { resetGraphileSchema } from './helpers/graphile'
import { pluginConfig39 } from './helpers/plugins'
import { resetTestDatabase } from './helpers/sql'

jest.mock('../src/utils/db/sql')
jest.setTimeout(60000) // 60 sec timeout

const { console: testConsole } = imports['test-utils/write-to-file']

const testCode = `
    import { console } from 'test-utils/write-to-file'

    export const jobs = {
        logReply: (text, meta) => {
            console.log('reply', text)
        }
    }
    export async function processEvent (event, { jobs }) {
        console.log('processEvent')
        if (event.properties?.type === 'runIn') {
            jobs.logReply('runIn').runIn(1, 'second')
        } else if (event.properties?.type === 'runAt') {
            jobs.logReply('runAt').runAt(new Date())
        } else if (event.properties?.type === 'runNow') {
            jobs.logReply('runNow').runNow()
        }
        return event
    }
`

const createConfig = (jobQueues: string) => ({
    WORKER_CONCURRENCY: 2,
    LOG_LEVEL: LogLevel.Debug,
    JOB_QUEUES: jobQueues,
})

describe('job queues', () => {
    let server: ServerInstance
    let posthog: DummyPostHog

    beforeEach(async () => {
        testConsole.reset()

        // reset lock in redis
        const [tempServer, stopTempServer] = await createServer()
        const redis = await tempServer.redisPool.acquire()
        await redis.del(LOCKED_RESOURCE)
        await tempServer.redisPool.release(redis)
        await stopTempServer()

        // reset test code
        await resetTestDatabase(testCode)
    })

    afterEach(async () => {
        await server.stop()
    })

    describe('fs queue', () => {
        beforeEach(async () => {
            server = await startPluginsServer(createConfig('fs'), makePiscina)
            posthog = createPosthog(server.server, pluginConfig39)
        })

        test('jobs get scheduled with runIn', async () => {
            posthog.capture('my event', { type: 'runIn' })
            await delay(3000)
            expect(testConsole.read()).toEqual([['processEvent'], ['reply', 'runIn']])
        })

        test('jobs get scheduled with runAt', async () => {
            posthog.capture('my event', { type: 'runAt' })
            await delay(3000)
            expect(testConsole.read()).toEqual([['processEvent'], ['reply', 'runAt']])
        })

        test('jobs get scheduled with runNow', async () => {
            posthog.capture('my event', { type: 'runNow' })
            await delay(3000)
            expect(testConsole.read()).toEqual([['processEvent'], ['reply', 'runNow']])
        })
    })

    describe('graphile', () => {
        beforeEach(async () => {
            await resetGraphileSchema()
            server = await startPluginsServer(createConfig('graphile'), makePiscina)
            posthog = createPosthog(server.server, pluginConfig39)
        })

        test('graphile job queue', async () => {
            posthog.capture('my event', { type: 'runIn' })
            await delay(5000)
            expect(testConsole.read()).toEqual([['processEvent'], ['runIn', 'runIn']])
        })
    })
})
