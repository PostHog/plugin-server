import { makeWorkerUtils } from 'graphile-worker'
import { Pool } from 'pg'

import { defaultConfig } from '../../src/config/config'
import { status } from '../../src/utils/status'

export async function resetGraphileSchema(): Promise<void> {
    const db = new Pool({ connectionString: defaultConfig.DATABASE_URL })

    try {
        await db.query('DROP SCHEMA graphile_worker CASCADE')
    } catch (error) {
        if (error.message !== 'schema "graphile_worker" does not exist') {
            throw error
        }
    } finally {
        await db.end()
    }

    const workerUtils = await makeWorkerUtils({
        connectionString: defaultConfig.DATABASE_URL,
    })
    await workerUtils.migrate()
    await workerUtils.release()
}
