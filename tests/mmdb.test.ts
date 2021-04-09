import { ReaderModel } from '@maxmind/geoip2-node'
import { readFileSync } from 'fs'
import { DateTime } from 'luxon'
import * as fetch from 'node-fetch'
import { join } from 'path'

import { startPluginsServer } from '../src/main/pluginsServer'
import { defaultConfig } from '../src/shared/config'
import { fetchIpLocationInternally } from '../src/shared/mmdb'
import { makePiscina } from '../src/worker/piscina'
import { resetTestDatabase } from './helpers/sql'

const mmdbBrotliContents = readFileSync(join(__dirname, 'assets', 'GeoLite2-City-Test.mmdb.br'))

async function resetTestDatabaseWithMmdb(): Promise<void> {
    await resetTestDatabase(undefined, undefined, {
        pluginAttachments: [
            {
                key: '@posthog/mmdb',
                content_type: 'vnd.maxmind.maxmind-db',
                file_name: `GeoLite2-City-${DateTime.local().toISODate()}.mmdb.br`,
                file_size: mmdbBrotliContents.byteLength,
                contents: mmdbBrotliContents,
                team_id: null,
                plugin_config_id: null,
            },
        ],
    })
}

jest.setTimeout(20_000)

afterEach(() => {
    jest.clearAllMocks()
})

test('no MMDB is used or available if MMDB disabled', async () => {
    await resetTestDatabase()

    const serverInstance = await startPluginsServer({ DISABLE_MMDB: true }, makePiscina)

    expect(serverInstance.server.DISABLE_MMDB).toBeTruthy()

    expect(fetch).not.toHaveBeenCalled()
    expect(serverInstance.mmdb).toBeUndefined()

    await expect(
        async () => await fetchIpLocationInternally('89.160.20.129', serverInstance.server)
    ).rejects.toThrowError('IP location capabilities are not available in this PostHog instance!')

    await serverInstance.stop()
})

test('fresh MMDB is downloaded if not cached and works', async () => {
    await resetTestDatabase()

    const serverInstance = await startPluginsServer({ DISABLE_MMDB: false }, makePiscina)

    expect(serverInstance.server.DISABLE_MMDB).toBeFalsy()

    expect(fetch).toHaveBeenCalledWith('https://mmdb.posthog.net/', { compress: false })
    expect(serverInstance.mmdb).toBeInstanceOf(ReaderModel)

    const cityResultDirect = serverInstance.mmdb!.city('89.160.20.129')
    expect(cityResultDirect.city).toBeDefined()
    expect(cityResultDirect.city!.names.en).toStrictEqual('Linköping')

    const cityResultDirectInvalid = await fetchIpLocationInternally('asdfgh', serverInstance.server)
    expect(cityResultDirectInvalid).toBeNull()

    const cityResultTcp = await fetchIpLocationInternally('89.160.20.129', serverInstance.server)
    expect(cityResultTcp).toBeTruthy()
    expect(cityResultTcp!.city).toBeDefined()
    expect(cityResultTcp!.city!.names.en).toStrictEqual('Linköping')

    const cityResultTcpInvalid = await fetchIpLocationInternally('asdfgh', serverInstance.server)
    expect(cityResultTcpInvalid).toBeNull()

    await serverInstance.stop()
})

test('cached MMDB is used and works', async () => {
    await resetTestDatabaseWithMmdb()

    const serverInstance = await startPluginsServer({ DISABLE_MMDB: false }, makePiscina)

    expect(serverInstance.server.DISABLE_MMDB).toBeFalsy()

    expect(fetch).not.toHaveBeenCalled()
    expect(serverInstance.mmdb).toBeInstanceOf(ReaderModel)

    const cityResultDirect = serverInstance.mmdb!.city('89.160.20.129')
    expect(cityResultDirect.city).toBeDefined()
    expect(cityResultDirect.city!.names.en).toStrictEqual('Linköping')

    const cityResultDirectInvalid = await fetchIpLocationInternally('asdfgh', serverInstance.server)
    expect(cityResultDirectInvalid).toBeNull()

    const cityResultTcp = await fetchIpLocationInternally('89.160.20.129', serverInstance.server)
    expect(cityResultTcp).toBeTruthy()
    expect(cityResultTcp!.city).toBeDefined()
    expect(cityResultTcp!.city!.names.en).toStrictEqual('Linköping')

    const cityResultTcpInvalid = await fetchIpLocationInternally('asdfgh', serverInstance.server)
    expect(cityResultTcpInvalid).toBeNull()

    await serverInstance.stop()
})
