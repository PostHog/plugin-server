import { PluginsServer } from '../../src/types'
import { createServer } from '../../src/server'
import { resetTestDatabase } from '../helpers/sql'
import { resetTestDatabaseClickhouse } from '../helpers/clickhouse'
import { KafkaCollector, KafkaObserver } from '../helpers/kafka'
import { UUIDT } from '../../src/utils'
import { DateTime } from 'luxon'

jest.setTimeout(180_000) // 3 minute timeout

let server: PluginsServer
let closeServer: () => Promise<void>
const kafkaObserver = new KafkaObserver()

beforeEach(async () => {
    ;[server, closeServer] = await createServer()
    await resetTestDatabase(`const processEvent = event => event`)
    await resetTestDatabaseClickhouse()
})
afterEach(() => {
    closeServer()
})

test('event is passed through', async () => {
    const uuid = new UUIDT().toString()
    const now = DateTime.utc()
    console.log('starting kafka observer')
    await kafkaObserver.start()
    console.log('sending message')
    const kafkaCollector = new KafkaCollector(kafkaObserver)
    await kafkaObserver.handOffMessage({
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
    console.log('waiting for messages')
    const processedMessages = await kafkaCollector.collect(1)

    console.log(processedMessages)
    expect(1).toEqual(1)
})
