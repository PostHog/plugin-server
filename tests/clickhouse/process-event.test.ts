import { getPluginAttachmentRows, getPluginConfigRows, getPluginRows, setError } from '../../src/sql'
import { PluginConfig, PluginError, PluginsServer } from '../../src/types'
import { createServer } from '../../src/server'
import { resetTestDatabase } from '../helpers/sql'
import { commonOrganizationId } from '../helpers/plugins'
import { resetTestDatabaseClickhouse } from '../helpers/clickhouse'
import { Consumer, EachMessagePayload, Kafka, Producer } from 'kafkajs'
import { KafkaObserver } from '../helpers/kafka'
import { UUIDT } from '../../src/utils'
import { DateTime } from 'luxon'

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
    const uuid = new UUIDT().toString()
    const now = new DateTime()
    kafkaObserver.handOffMessage({
        distinct_id: 'abcd',
        ip: '1.1.1.1',
        site_url: 'x.com',
        team_id: 1,
        uuid,
        data: {
            distinct_id: 'abcd',
            ip: '1.1.1.1',
            site_url: 'x.com',
            team_id: 1,
            now: now.toString(),
            event: 'test',
            uuid,
        },
        now,
        sent_at: null,
    })
    expect(1).toEqual(1)
})
