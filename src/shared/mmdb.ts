import { Reader, ReaderModel } from '@maxmind/geoip2-node'
import { GeoIPExtension } from '@posthog/plugin-scaffold'
import { DateTime } from 'luxon'
import mmapObject from 'mmap-object'
import fetch from 'node-fetch'
import prettyBytes from 'pretty-bytes'
import { isMainThread } from 'worker_threads'
import { brotliDecompress } from 'zlib'

import { PluginAttachmentDB, PluginsServer } from '../types'
import { status } from './status'
import { delay } from './utils'

const MMDB_ENDPOINT = 'https://mmdb.posthog.net/'
const MMDB_ATTACHMENT_KEY = '@posthog/mmdb'
const MMDB_FILE_NAME = 'posthog-mmdb'
const MMDB_STALE_AGE_DAYS = 14
const MMDB_STATUS_REDIS_KEY = '@posthog-plugin-server/mmdb-status'

enum MmdbStatus {
    Idle = 'idle',
    Fetching = 'fetching',
    Unavailable = 'unavailable',
}

/** Check if MMDB is being currently fetched by any other plugin server worker in the cluster. */
async function getMmdbStatus(server: PluginsServer): Promise<MmdbStatus> {
    return (await server.db.redisGet(MMDB_STATUS_REDIS_KEY, MmdbStatus.Idle)) as MmdbStatus
}

/** Decompress a Brotli-compressed MMDB buffer and open a reader from it. */
async function decompressAndOpenMmdb(brotliContents: Buffer, filename: string): Promise<ReaderModel> {
    let decompressedContents: Buffer
    let sharedObject: mmapObject.Open | undefined
    if (isMainThread) {
        decompressedContents = await new Promise((resolve, reject) => {
            brotliDecompress(brotliContents, (error, result) => {
                if (error) {
                    reject(error)
                } else {
                    resolve(result)
                }
            })
        })
        status.info(
            '🪗',
            `Decompressed ${filename} from ${prettyBytes(brotliContents.byteLength)} into ${prettyBytes(
                decompressedContents.byteLength
            )}`
        )
        sharedObject = new mmapObject.Create(MMDB_FILE_NAME, 80 * 1024, 4, 320 * 1024)
        sharedObject.mmdbContents = decompressedContents
    } else {
        while (!sharedObject) {
            try {
                sharedObject = new mmapObject.Open(MMDB_FILE_NAME)
            } catch (e) {
                status.error('☹️', e)
                await delay(250)
            }
        }
        decompressedContents = sharedObject.mmdbContents as Buffer
    }
    return Reader.openBuffer(decompressedContents)
}

/** Download latest MMDB database, save it, and return its reader. */
async function fetchAndInsertFreshMmdb(server: PluginsServer): Promise<ReaderModel> {
    const { db } = server

    status.info('⏳', 'Downloading GeoLite2 database from PostHog servers...')
    const response = await fetch(MMDB_ENDPOINT, { compress: false })
    const contentType = response.headers.get('content-type')
    const filename = response.headers.get('content-disposition')!.match(/filename="(.+)"/)![1]
    const brotliContents = await response.buffer()
    status.info('✅', `Downloaded ${filename} of ${prettyBytes(brotliContents.byteLength)}`)

    // Insert new attachment
    const newAttachmentResults = await db.postgresQuery<PluginAttachmentDB>(
        `
        INSERT INTO posthog_pluginattachment (
            key, content_type, file_name, file_size, contents, plugin_config_id, team_id
        ) VALUES ($1, $2, $3, $4, $5, NULL, NULL) RETURNING *
    `,
        [MMDB_ATTACHMENT_KEY, contentType, filename + '.br', brotliContents.byteLength, brotliContents]
    )
    // Ensure that there's no old attachments lingering
    await db.postgresQuery(
        `
        DELETE FROM posthog_pluginattachment WHERE key = $1 AND id != $2
    `,
        [MMDB_ATTACHMENT_KEY, newAttachmentResults.rows[0].id]
    )
    status.info('💾', `Saved ${filename} into the database`)

    return await decompressAndOpenMmdb(brotliContents, filename)
}

/** Drop-in replacement for fetchAndInsertFreshMmdb that handles multiple worker concurrency better. */
async function distributableFetchAndInsertFreshMmdb(server: PluginsServer): Promise<ReaderModel | null> {
    let fetchingStatus = await getMmdbStatus(server)
    if (fetchingStatus === MmdbStatus.Unavailable) {
        status.info(
            '☹️',
            'MMDB fetch and insert for GeoIP capabilities is currently unavailable in this PostHog instance - IP location data may be stale or unavailable'
        )
        return null
    }
    if (fetchingStatus === MmdbStatus.Fetching) {
        while (fetchingStatus === MmdbStatus.Fetching) {
            // Retrying shortly, when perhaps the MMDB has been fetched somewhere else and the attachment is up to date
            // Only one plugin server thread out of instances*(workers+1) needs to download the file this way
            await delay(200)
            fetchingStatus = await getMmdbStatus(server)
        }
        return prepareMmdb(server)
    }
    // Allow 120 seconds of download until another worker retries
    await server.db.redisSet(MMDB_STATUS_REDIS_KEY, MmdbStatus.Fetching, 120)
    try {
        const mmdb = await fetchAndInsertFreshMmdb(server)
        await server.db.redisSet(MMDB_STATUS_REDIS_KEY, MmdbStatus.Idle)
        return mmdb
    } catch (e) {
        // In case of an error mark the MMDB feature unavailable for an hour
        await server.db.redisSet(MMDB_STATUS_REDIS_KEY, MmdbStatus.Unavailable, 120)
        status.error('❌', 'An error occurred during MMDB fetch and insert:', e)
        return null
    }
}

/** Update server MMDB in the background, with no availability interruptions. */
async function backgroundInjectFreshMmdb(server: PluginsServer): Promise<void> {
    const mmdb = await distributableFetchAndInsertFreshMmdb(server)
    if (mmdb) {
        server.mmdb = mmdb
        status.info('💉', `Injected fresh ${MMDB_ATTACHMENT_KEY} into the plugin server`)
    }
}

/** Ensure that an MMDB is available and return its reader. If needed, update the MMDB in the background. */
export async function prepareMmdb(server: PluginsServer, onlyBackground?: false): Promise<ReaderModel | null>
export async function prepareMmdb(server: PluginsServer, onlyBackground: true): Promise<boolean>
export async function prepareMmdb(
    server: PluginsServer,
    onlyBackground = false
): Promise<ReaderModel | null | boolean> {
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
        if (onlyBackground) {
            await backgroundInjectFreshMmdb(server)
            return true
        } else {
            const mmdb = await distributableFetchAndInsertFreshMmdb(server)
            if (!mmdb) {
                status.warn('🤒', 'Because of MMDB unavailability, GeoIP plugins will fail in this PostHog instance')
            }
            return mmdb
        }
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
        if (onlyBackground) {
            await backgroundInjectFreshMmdb(server)
            return true
        } else {
            void backgroundInjectFreshMmdb(server)
        }
    }

    if (onlyBackground) {
        return false
    } else {
        return await decompressAndOpenMmdb(mmdbRow.contents, mmdbRow.file_name)
    }
}

/** Check for MMDB staleness every 4 hours, if needed perform a no-interruption update. */
export async function performMmdbStalenessCheck(server: PluginsServer): Promise<void> {
    status.info('⏲', 'Performing periodic MMDB staleness check...')
    const wasUpdatePerformed = await prepareMmdb(server, true)
    if (wasUpdatePerformed) {
        status.info('✅', 'MMDB staleness check completed, update performed')
    } else {
        status.info('❎', 'MMDB staleness check completed, no update was needed')
    }
}
