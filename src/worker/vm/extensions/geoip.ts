import { Reader, ReaderModel } from '@maxmind/geoip2-node'
import { GeoIPExtension } from '@posthog/plugin-scaffold'
import fetch from 'node-fetch'
import { threadId } from 'worker_threads'

import { DB } from '../../../shared/db'
import { status } from '../../../shared/status'

const MMDB_REDIS_KEY = '@posthog-plugin-server/mmdb'
const MMDB_STATIC_ENDPOINT = 'https://mmdb.posthog.net/'

export async function prepareMmdb(db: DB): Promise<ReaderModel> {
    const mmdbString = (await db.redisGet(MMDB_REDIS_KEY, null, { jsonSerialize: false })) as string | null
    let mmdb: Buffer | null = mmdbString === null ? null : Buffer.from(mmdbString, 'binary')
    if (!mmdb) {
        status.info('⏳', 'GeoLite2 database not in cache, downloading...')
        const response = await fetch(MMDB_STATIC_ENDPOINT)
        mmdb = await response.buffer()
        status.info('⌛️', 'Downloaded GeoLite2 database')
        await db.redisSet(MMDB_REDIS_KEY, mmdb.toString('binary'), 7 * 86_400, { jsonSerialize: false })
        status.info('🌍', 'Cached GeoLite2 database for a week')
    } else if (threadId === 0) {
        // Only logging this in the main thread
        status.info('🌍', 'Using GeoLite2 database from cache')
    }
    return Reader.openBuffer(mmdb)
}

function throwMmdbUnavailable(): never {
    throw new Error(
        'IP location capabilities are unavailable in this PostHog instance due to the DISABLE_MMDB setting!'
    )
}

export function createGeoIp(reader: ReaderModel | null): GeoIPExtension {
    return reader
        ? {
              locate: function (ip) {
                  try {
                      return reader.city(ip)
                  } catch {
                      return null
                  }
              },
          }
        : {
              locate: throwMmdbUnavailable,
          }
}
