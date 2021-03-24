import { Reader, ReaderModel } from '@maxmind/geoip2-node'
import { GeoIPExtension } from '@posthog/plugin-scaffold'
import { DateTime } from 'luxon'
import fetch from 'node-fetch'
import { threadId } from 'worker_threads'
import { brotliDecompress, brotliDecompressSync } from 'zlib'

import { DB } from '../../../shared/db'
import { status } from '../../../shared/status'
import { PluginAttachmentDB, PluginsServer } from '../../../types'

const MMDB_ENDPOINT = 'https://mmdb.posthog.net/'
const MMDB_ATTACHMENT_KEY = '@posthog/mmdb'

async function fetchAndInsertFreshMmdb(server: PluginsServer): Promise<ReaderModel> {
    const { db } = server

    status.info('⏳', 'Downloading GeoLite2 database from PostHog servers...')

    const response = await fetch(MMDB_ENDPOINT)
    const contentType = response.headers.get('content-type')
    const filename = response.headers.get('content-disposition')!.match(/filename="(.+)"/)![1]
    const compressedContents = await response.buffer()

    await db.postgresQuery(
        `
        INSERT INTO posthog_pluginattachment (
            key, content_type, file_name, file_size, contents, plugin_config_id, team_id
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL)
    `,
        [MMDB_ATTACHMENT_KEY, contentType, filename, compressedContents]
    )

    return new Promise((resolve, reject) => {
        brotliDecompress(compressedContents, (error, result) => {
            if (error) {
                reject(error)
            } else {
                resolve(Reader.openBuffer(result))
            }
        })
    })
}

async function backgroundInjectFreshMmdb(server: PluginsServer): Promise<void> {
    server.mmdb = await fetchAndInsertFreshMmdb(server)
}

export async function prepareMmdb(server: PluginsServer): Promise<ReaderModel> {
    const { db } = server
    const readResults = await db.postgresQuery<PluginAttachmentDB>(
        `
        SELECT * FROM posthog_pluginattachment
        WHERE key = ? AND plugin_config_id IS NULL AND team_id IS NULL
    `,
        [MMDB_ATTACHMENT_KEY]
    )
    if (!readResults.rowCount) {
        // Fetching MMDB for the first time
        return await fetchAndInsertFreshMmdb(server)
    }
    const [mmdbRow] = readResults.rows
    if (!mmdbRow.contents) {
        throw new Error(`${MMDB_ATTACHMENT_KEY} attachment ID ${mmdbRow.id} has no file contents!`)
    }
    const mmdbDateStringMatch = mmdbRow.file_name.match(/\d{4}-\d{2}-\d{2}/)
    if (!mmdbDateStringMatch) {
        throw new Error(
            `${MMDB_ATTACHMENT_KEY} attachment ID ${mmdbRow.id} has an invalid filename! ${MMDB_ATTACHMENT_KEY} filename must include an ISO date`
        )
    }
    const mmdbAge = DateTime.fromISO(mmdbDateStringMatch[0]).diffNow().days
    status.info('ℹ️', `Fetched MMDB is ${mmdbAge} days old`)
    if (mmdbAge > 21) {
        status.info('🔁', 'MMDB is more than 3 weeks old, refreshing in the background...')
        void backgroundInjectFreshMmdb(server)
    }

    return new Promise((resolve, reject) => {
        brotliDecompress(mmdbRow.contents!, (error, result) => {
            if (error) {
                reject(error)
            } else {
                resolve(Reader.openBuffer(result))
            }
        })
    })
}

function throwMmdbUnavailable(): never {
    throw new Error('IP location capabilities are not available in this PostHog at the moment!')
}

export function createGeoIp(server: PluginsServer): GeoIPExtension {
    return {
        locate: function (ip) {
            if (!server.mmdb) {
                throwMmdbUnavailable()
            }
            try {
                return server.mmdb.city(ip)
            } catch {
                return null
            }
        },
    }
}
