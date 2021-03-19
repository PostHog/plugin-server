import { Reader, ReaderModel } from '@maxmind/geoip2-node'
import { GeoIPExtension } from '@posthog/plugin-scaffold'
import fetch from 'node-fetch'
import { threadId } from 'worker_threads'

import { DB } from '../../db'
import { status } from '../../status'

const REDIS_MMDB_KEY = '@posthog-plugin-server/mmdb'

export async function prepareMmdb(db: DB): Promise<ReaderModel> {
    const mmdbString = (await db.redisGet(REDIS_MMDB_KEY, null, { jsonSerialize: false })) as string | null
    let mmdb: Buffer | null = mmdbString === null ? null : Buffer.from(mmdbString, 'binary')
    if (!mmdb) {
        status.info('⏳', 'GeoLite2 database not in cache, downloading...')
        const response = await fetch('http://posthog-mmdb.herokuapp.com/')
        mmdb = await response.buffer()
        status.info('⌛️', 'Downloaded GeoLite2 database')
        await db.redisSet(REDIS_MMDB_KEY, mmdb.toString('binary'), 7 * 86_400, { jsonSerialize: false })
        status.info('🌍', 'Cached GeoLite2 database for a week')
    } else if (threadId === 0) {
        // Only logging this in the main thread
        status.info('🌍', 'Using GeoLite2 database from cache')
    }
    return Reader.openBuffer(mmdb)
}

export function createGeoIp(reader: ReaderModel): GeoIPExtension {
    return {
        locate: function (ip) {
            try {
                return reader.city(ip)
            } catch {
                return null
            }
        },
    }
}
