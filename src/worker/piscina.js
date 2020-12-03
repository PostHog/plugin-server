const { isMainThread } = require('worker_threads')

if (isMainThread) {
    const Piscina = require('piscina')
    const { createConfig } = require('./config')
    module.exports = { makePiscina: (serverConfig) => new Piscina(createConfig(serverConfig, __filename)) }
} else {
    console.log('🧵 Starting Piscina Worker Thread')

    if (areWeTestingWithJest()) {
        require('ts-node').register()
        const { worker } = require('./worker.ts')
        module.exports = worker
    } else {
        const { createWorker } = require('./worker')
        const { workerData } = require('piscina')
        module.exports = createWorker(workerData.serverConfig)
    }
}

function areWeTestingWithJest() {
    return process.env.JEST_WORKER_ID !== undefined
}
