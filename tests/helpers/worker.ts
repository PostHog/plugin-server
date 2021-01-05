import Piscina from 'piscina'
import { makePiscina } from '../../src/worker/piscina'
import { defaultConfig } from '../../src/config'
import { LogLevel } from '../../src/types'

export async function setupPiscina(workers: number, tasksPerWorker: number): Promise<Piscina> {
    return makePiscina({
        ...defaultConfig,
        WORKER_CONCURRENCY: workers,
        TASKS_PER_WORKER: tasksPerWorker,
        LOG_LEVEL: LogLevel.Log,
    })
}
