import { getPluginAttachmentRows, getPluginConfigRows, getPluginRows, setError } from '../../src/sql'
import { PluginConfig, PluginError, PluginsServer } from '../../src/types'
import { createServer } from '../../src/server'
import { resetTestDatabase } from '../helpers/sql'
import { organizationId } from '../helpers/plugins'
import { resetTestDatabaseClickhouse } from '../helpers/clickhouse'
import { Consumer, EachMessagePayload, Kafka, Producer } from 'kafkajs'
import { KafkaObserver } from '../helpers/kafka'

let server: PluginsServer
let closeServer: () => Promise<void>
kafkaObserver = new KafkaObserver()

beforeEach(async () => {
    ;[server, closeServer] = await createServer()
    await resetTestDatabase(`const processEvent = event => event`)
    await resetTestDatabaseClickhouse()
    await kafkaObserver.start()
})
afterEach(() => {
    closeServer()
})

test('event is passed through', async () => {
    const rows1 = await getPluginAttachmentRows(server)
    expect(rows1).toEqual([
        {
            content_type: 'application/octet-stream',
            contents: Buffer.from([116, 101, 115, 116]),
            file_name: 'test.txt',
            file_size: 4,
            id: 1,
            key: 'maxmindMmdb',
            plugin_config_id: 39,
            team_id: 2,
        },
    ])
    server.db.query("update posthog_team set plugins_opt_in='f'")
    const rows2 = await getPluginAttachmentRows(server)
    expect(rows2).toEqual([])
})
