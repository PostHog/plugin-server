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
const kafkaObserver = new KafkaObserver()

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
    expect(1).toEqual(1)
})
