import { Reader, ReaderModel } from '@maxmind/geoip2-node'
import { GeoIPExtension } from '@posthog/plugin-scaffold'
import { DateTime } from 'luxon'
import fetch from 'node-fetch'
import prettyBytes from 'pretty-bytes'
import { brotliDecompress } from 'zlib'

import { PluginAttachmentDB, PluginsServer } from '../types'
import { status } from './status'
import { delay } from './utils'

const MMDB_ENDPOINT = 'https://mmdb.posthog.net/'
const MMDB_ATTACHMENT_KEY = '@posthog/mmdb'
const MMDB_STALE_AGE_DAYS = 21
const MMDB_STATUS_REDIS_KEY = '@posthog-plugin-server/mmdb-being-fetched'

async function isMmdbBeingFetchedSomewhere(server: PluginsServer): Promise<boolean> {
    const fetchingStatus = await server.db.redisGet(MMDB_STATUS_REDIS_KEY, 'false')
    return fetchingStatus === 'true'
}

/** Download latest MMDB database, save it, and return its reader. */
async function fetchAndInsertFreshMmdb(server: PluginsServer): Promise<ReaderModel> {
    const { db } = server

    status.info('⏳', 'Downloading GeoLite2 database from PostHog servers...')
    const response = await fetch(MMDB_ENDPOINT, { compress: false })
    const contentType = response.headers.get('content-type')
    const filename = response.headers.get('content-disposition')!.match(/filename="(.+)"/)![1]
    const compressedContents = await response.buffer()
    status.info('✅', `Downloaded ${filename} of ${prettyBytes(compressedContents.byteLength)}`)

    // Insert new attachment
    const newAttachmentResults = await db.postgresQuery<PluginAttachmentDB>(
        `
        INSERT INTO posthog_pluginattachment (
            key, content_type, file_name, file_size, contents, plugin_config_id, team_id
        ) VALUES ($1, $2, $3, $4, $5, NULL, NULL) RETURNING *
    `,
        [MMDB_ATTACHMENT_KEY, contentType, filename, compressedContents.byteLength, compressedContents]
    )
    // Ensure that there's no old attachments lingering
    await db.postgresQuery(
        `
        DELETE FROM posthog_pluginattachment WHERE key = $1 AND id != $2
    `,
        [MMDB_ATTACHMENT_KEY, newAttachmentResults.rows[0].id]
    )

    // Decompress buffer and open a reader with it
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

/** Drop-in replacement for fetchAndInsertFreshMmdb that handles multiple worker concurrency better. */
async function distributableFetchAndInsertFreshMmdb(server: PluginsServer): Promise<ReaderModel> {
    let fetchingStatus = await isMmdbBeingFetchedSomewhere(server)
    if (fetchingStatus) {
        while (fetchingStatus) {
            // Retrying shortly, when perhaps the MMDB has been fetched somewhere else and the attachment is up to date
            // Only one plugin server thread out of instances*(workers+1) needs to download the file this way
            await delay(100)
            fetchingStatus = await isMmdbBeingFetchedSomewhere(server)
        }
        return prepareMmdb(server)
    }
    // Allow 120 seconds of download until another worker retries
    await server.db.redisSet(MMDB_STATUS_REDIS_KEY, 'true', 120)
    try {
        return await fetchAndInsertFreshMmdb(server)
    } finally {
        await server.db.redisSet(MMDB_STATUS_REDIS_KEY, 'false')
    }
}

/** Update server MMDB in the background. */
async function backgroundInjectFreshMmdb(server: PluginsServer): Promise<void> {
    server.mmdb = await distributableFetchAndInsertFreshMmdb(server)
    status.info('💉', `Injected fresh ${MMDB_ATTACHMENT_KEY} into the plugin server`)
}

/** Ensure that an MMDB is available and return its reader. If needed, update the MMDB in the background. */
export async function prepareMmdb(server: PluginsServer): Promise<ReaderModel> {
    const { db } = server

    const readResults = await db.postgresQuery<PluginAttachmentDB>(
        `
        SELECT * FROM posthog_pluginattachment
        WHERE key = $1 AND plugin_config_id IS NULL AND team_id IS NULL
        ORDER BY file_name ASC
    `,
        [MMDB_ATTACHMENT_KEY]
    )
    if (!readResults.rowCount) {
        status.info('⬇️', `Fetching ${MMDB_ATTACHMENT_KEY} for the first time`)
        return await distributableFetchAndInsertFreshMmdb(server)
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
    const mmdbAge = Math.round(-DateTime.fromISO(mmdbDateStringMatch[0]).diffNow().as('days'))
    if (mmdbAge > MMDB_STALE_AGE_DAYS) {
        status.info(
            '🔁',
            `${MMDB_ATTACHMENT_KEY} is ${mmdbAge} ${
                mmdbAge === 1 ? 'day' : 'days'
            } old, which is more than the staleness threshold of ${MMDB_STALE_AGE_DAYS} days, refreshing in the background...`
        )
        void backgroundInjectFreshMmdb(server)
    }

    // Decompress buffer and open a reader with it
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
