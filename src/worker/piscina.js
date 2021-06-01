const Sentry = require('@sentry/node')
const { isMainThread, threadId } = require('worker_threads')

if (isMainThread) {
    const Piscina = require('@posthog/piscina')
    const { createConfig } = require('./config')
    module.exports = {
        makePiscina: (serverConfig) => {
            const config = createConfig(serverConfig, __filename)
            if (config.maxThreads === 1) {
                const { createWorker } = require('./worker')
                const workerPromise = createWorker(serverConfig, threadId)
                const promises = new Set()
                let completed = 0
                const awaitWorker = async ({ task, args }) => await (await workerPromise)({ task, args })
                const trackedWorker = ({ task, args }) => {
                    const promise = awaitWorker({ task, args })
                    promises.add(promise)
                    promise.finally(() => {
                        promises.delete(promise)
                        completed++
                    })
                    return promise
                }
                return {
                    runTask: ({ task, args }) => trackedWorker({ task, args }),
                    broadcastTask: ({ task, args }) => trackedWorker({ task, args }),
                    destroy: () => Promise.all(promises),
                    on: () => undefined,
                    options: {},
                    queueSize: 0,
                    threads: [true],
                    completed: completed,
                    waitTime: 0,
                    runTime: 0,
                    utilization: 0,
                    duration: 0,
                    isWorkerThread: true,
                    workerData: null,
                    version: 'test',
                }
            } else {
                const piscina = new Piscina(config)
                piscina.on('error', (error) => {
                    Sentry.captureException(error)
                    console.error('⚠️', 'Piscina worker thread error:\n', error)
                })
                return piscina
            }
        },
    }
} else {
    if (process.env.NODE_ENV === 'test') {
        require('ts-node').register()
    }

    const { createWorker } = require('./worker')
    const { workerData } = require('@posthog/piscina')
    module.exports = createWorker(workerData.serverConfig, threadId)
}
