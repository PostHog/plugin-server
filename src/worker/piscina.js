const Sentry = require('@sentry/node')
const { areWeTestingWithJest } = require('utils')

const { isMainThread, threadId } = require('worker_threads')

if (isMainThread) {
    const Piscina = require('piscina')
    const { createConfig } = require('./config')
    module.exports = {
        makePiscina: (serverConfig) => {
            const piscina = new Piscina(createConfig(serverConfig, __filename))
            piscina.on('error', (error) => {
                Sentry.captureException(error)
                console.error(`⚠️ Piscina worker thread ${threadId} error!`)
                console.error(error)
            })
            return piscina
        },
    }
} else {
    if (areWeTestingWithJest()) {
        require('ts-node').register()
    }

    const { createWorker } = require('./worker')
    const { workerData } = require('piscina')
    module.exports = createWorker(workerData.serverConfig, threadId)
}
