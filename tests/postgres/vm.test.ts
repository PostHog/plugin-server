import { PluginEvent } from '@posthog/plugin-scaffold'
import * as fetch from 'node-fetch'

import { JobQueueManager } from '../../src/main/job-queues/job-queue-manager'
import { PluginsServer } from '../../src/types'
import { Client } from '../../src/utils/celery/client'
import { createServer } from '../../src/utils/db/server'
import { delay } from '../../src/utils/utils'
import { createPluginConfigVM } from '../../src/worker/vm/vm'
import { pluginConfig39 } from '../helpers/plugins'
import { resetTestDatabase } from '../helpers/sql'

jest.mock('../../src/utils/celery/client')
jest.mock('../../src/main/job-queues/job-queue-manager')
jest.setTimeout(30000)

const defaultEvent = {
    distinct_id: 'my_id',
    ip: '127.0.0.1',
    site_url: 'http://localhost',
    team_id: 3,
    now: new Date().toISOString(),
    event: 'default event',
}

let mockServer: PluginsServer
let stopServer: () => Promise<void>

beforeEach(async () => {
    ;(Client as any).mockClear()
    ;[mockServer, stopServer] = await createServer()
})

afterEach(async () => {
    await stopServer()
    jest.clearAllMocks()
})

test('empty plugins', async () => {
    const indexJs = ''
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)

    expect(Object.keys(vm).sort()).toEqual(['methods', 'tasks', 'vm'])
    expect(Object.keys(vm.methods).sort()).toEqual([
        'exportEvents',
        'onEvent',
        'onSnapshot',
        'processEvent',
        'processEventBatch',
        'setupPlugin',
        'teardownPlugin',
    ])
    expect(vm.methods.processEvent).toEqual(undefined)
    expect(vm.methods.processEventBatch).toEqual(undefined)
})

test('setupPlugin sync', async () => {
    const indexJs = `
        function setupPlugin (meta) {
            meta.global.data = 'haha'
        }
        function processEvent (event, meta) {
            event.event = meta.global.data
            return event
        }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)
    const newEvent = await vm.methods.processEvent({ ...defaultEvent })
    expect(newEvent.event).toEqual('haha')
})

test('setupPlugin async', async () => {
    const indexJs = `
        async function setupPlugin (meta) {
            await new Promise(resolve => __jestSetTimeout(resolve, 500))
            meta.global.data = 'haha'
        }
        function processEvent (event, meta) {
            event.event = meta.global.data
            return event
        }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)
    const newEvent = await vm.methods.processEvent({ ...defaultEvent })
    expect(newEvent.event).toEqual('haha')
})

test('teardownPlugin', async () => {
    const indexJs = `
        function setupPlugin (meta) {
            meta.global.data = 'haha'
        }
        function teardownPlugin (meta) {
            fetch('https://google.com/results.json?query=' + meta.global.data)
        }
        function processEvent (event, meta) {
            meta.global.data = event.properties.haha
            return event
        }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)
    await vm.methods.processEvent({
        ...defaultEvent,
        properties: { haha: 'hoho' },
    })
    expect(fetch).not.toHaveBeenCalled()
    await vm.methods.teardownPlugin()
    expect(fetch).toHaveBeenCalledWith('https://google.com/results.json?query=hoho')
})

test('processEvent', async () => {
    const indexJs = `
        function processEvent (event, meta) {
            event.event = 'changed event'
            return event
        }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)
    expect(vm.methods.processEvent).not.toEqual(undefined)
    expect(vm.methods.processEventBatch).not.toEqual(undefined)

    const event: PluginEvent = {
        ...defaultEvent,
        event: 'original event',
    }
    const newEvent = await vm.methods.processEvent(event)
    expect(event.event).toEqual('changed event')
    expect(newEvent.event).toEqual('changed event')
    expect(newEvent).toBe(event)

    const batch: PluginEvent[] = [
        {
            ...defaultEvent,
            event: 'original event',
        },
    ]
    const newBatch = await vm.methods.processEventBatch(batch)
    expect(batch[0].event).toEqual('changed event')
    expect(newBatch[0].event).toEqual('changed event')
    expect(newBatch[0]).toBe(batch[0])
})

test('async processEvent', async () => {
    const indexJs = `
        async function processEvent (event, meta) {
            event.event = 'changed event'
            return event
        }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)
    expect(vm.methods.processEvent).not.toEqual(undefined)
    expect(vm.methods.processEventBatch).not.toEqual(undefined)

    const event: PluginEvent = {
        ...defaultEvent,
        event: 'original event',
    }
    const newEvent = await vm.methods.processEvent(event)
    expect(event.event).toEqual('changed event')
    expect(newEvent.event).toEqual('changed event')
    expect(newEvent).toBe(event)

    const batch: PluginEvent[] = [
        {
            ...defaultEvent,
            event: 'original event',
        },
    ]
    const newBatch = await vm.methods.processEventBatch(batch)
    expect(batch[0].event).toEqual('changed event')
    expect(newBatch[0].event).toEqual('changed event')
    expect(newBatch[0]).toBe(batch[0])
})

test('processEventBatch', async () => {
    const indexJs = `
        function processEventBatch (events, meta) {
            return events.map(event => {
                event.event = 'changed event'
                return event
            })
        }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)
    expect(vm.methods.processEvent).not.toEqual(undefined)
    expect(vm.methods.processEventBatch).not.toEqual(undefined)

    const event: PluginEvent = {
        ...defaultEvent,
        event: 'original event',
    }
    const newEvent = await vm.methods.processEvent(event)
    expect(event.event).toEqual('changed event')
    expect(newEvent.event).toEqual('changed event')
    expect(newEvent).toBe(event)

    const batch: PluginEvent[] = [
        {
            ...defaultEvent,
            event: 'original event',
        },
    ]
    const newBatch = await vm.methods.processEventBatch(batch)
    expect(batch[0].event).toEqual('changed event')
    expect(newBatch[0].event).toEqual('changed event')
    expect(newBatch[0]).toBe(batch[0])
})

test('async processEventBatch', async () => {
    const indexJs = `
        async function processEventBatch (events, meta) {
            return events.map(event => {
                event.event = 'changed event'
                return event
            })
        }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)
    expect(vm.methods.processEvent).not.toEqual(undefined)
    expect(vm.methods.processEventBatch).not.toEqual(undefined)

    const event: PluginEvent = {
        ...defaultEvent,
        event: 'original event',
    }
    const newEvent = await vm.methods.processEvent(event)
    expect(event.event).toEqual('changed event')
    expect(newEvent.event).toEqual('changed event')
    expect(newEvent).toBe(event)

    const batch: PluginEvent[] = [
        {
            ...defaultEvent,
            event: 'original event',
        },
    ]
    const newBatch = await vm.methods.processEventBatch(batch)
    expect(batch[0].event).toEqual('changed event')
    expect(newBatch[0].event).toEqual('changed event')
    expect(newBatch[0]).toBe(batch[0])
})

test('processEvent && processEventBatch', async () => {
    const indexJs = `
        function processEvent (event, meta) {
            event.event = 'changed event 1'
            return event
        }
        function processEventBatch (events, meta) {
            return events.map(event => {
                event.event = 'changed event 2'
                return event
            })
        }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)
    expect(vm.methods.processEvent).not.toEqual(undefined)
    expect(vm.methods.processEventBatch).not.toEqual(undefined)

    const event: PluginEvent = {
        ...defaultEvent,
        event: 'original event',
    }
    const newEvent = await vm.methods.processEvent(event)
    expect(event.event).toEqual('changed event 1')
    expect(newEvent.event).toEqual('changed event 1')
    expect(newEvent).toBe(event)

    const batch: PluginEvent[] = [
        {
            ...defaultEvent,
            event: 'original event',
        },
    ]
    const newBatch = await vm.methods.processEventBatch(batch)
    expect(batch[0].event).toEqual('changed event 2')
    expect(newBatch[0].event).toEqual('changed event 2')
    expect(newBatch[0]).toBe(batch[0])
})

test('processEvent without returning', async () => {
    const indexJs = `
        function processEvent (event, meta) {
            event.event = 'changed event'
        }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)
    expect(vm.methods.processEvent).not.toEqual(undefined)

    const event: PluginEvent = {
        ...defaultEvent,
        event: 'original event',
    }

    const newEvent = await vm.methods.processEvent(event)
    // this will be changed
    expect(event.event).toEqual('changed event')
    // but nothing was returned --> bail
    expect(newEvent).toEqual(undefined)
})

test('async processEvent', async () => {
    const indexJs = `
        async function processEvent (event, meta) {
            await new Promise((resolve) => resolve())
            event.event = 'changed event'
            await new Promise((resolve) => resolve())
            return event
        }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)

    const event: PluginEvent = {
        ...defaultEvent,
        event: 'original event',
    }
    await vm.methods.processEvent(event)

    expect(event.event).toEqual('changed event')
})

test('module.exports override', async () => {
    const indexJs = `
        function myProcessEventFunction (event, meta) {
            event.event = 'changed event';
            return event
        }
        module.exports = { processEvent: myProcessEventFunction }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)

    const event: PluginEvent = {
        ...defaultEvent,
        event: 'original event',
    }
    await vm.methods.processEvent(event)

    expect(event.event).toEqual('changed event')
})

test('module.exports set', async () => {
    const indexJs = `
        function myProcessEventFunction (event, meta) {
            event.event = 'changed event';
            return event
        }
        module.exports.processEvent = myProcessEventFunction
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)

    const event: PluginEvent = {
        ...defaultEvent,
        event: 'original event',
    }
    await vm.methods.processEvent(event)

    expect(event.event).toEqual('changed event')
})

test('exports override', async () => {
    const indexJs = `
        function myProcessEventFunction (event, meta) {
            event.event = 'changed event';
            return event
        }
        exports = { processEvent: myProcessEventFunction }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)
    const event: PluginEvent = {
        ...defaultEvent,
        event: 'original event',
    }
    await vm.methods.processEvent(event)

    expect(event.event).toEqual('changed event')
})

test('exports set', async () => {
    const indexJs = `
        function myProcessEventFunction (event, meta) {
            event.event = 'changed event';
            return event
        }
        exports.processEvent = myProcessEventFunction
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)
    const event: PluginEvent = {
        ...defaultEvent,
        event: 'original event',
    }
    await vm.methods.processEvent(event)

    expect(event.event).toEqual('changed event')
})

test('meta.config', async () => {
    const indexJs = `
        async function processEvent (event, meta) {
            event.properties = meta.config
            return event
        }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)
    const event: PluginEvent = {
        ...defaultEvent,
        event: 'original event',
        properties: {},
    }
    await vm.methods.processEvent(event)

    expect(event.properties).toEqual(pluginConfig39.config)
})

test('meta.cache set/get', async () => {
    const indexJs = `
        async function setupPlugin (meta) {
            await meta.cache.set('counter', 0)
        }
        async function processEvent (event, meta) {
            const counter = await meta.cache.get('counter', 999)
            meta.cache.set('counter', counter + 1)
            event.properties['counter'] = counter + 1
            return event
        }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)
    const event: PluginEvent = {
        ...defaultEvent,
        event: 'original event',
        properties: {},
    }

    await vm.methods.processEvent(event)
    expect(event.properties!['counter']).toEqual(1)

    await vm.methods.processEvent(event)
    expect(event.properties!['counter']).toEqual(2)

    await vm.methods.processEvent(event)
    expect(event.properties!['counter']).toEqual(3)
})

test('meta.storage set/get', async () => {
    const indexJs = `
        async function setupPlugin (meta) {
            await meta.storage.set('counter', -1)
            const c = await meta.storage.get('counter')
            if (c === -1) {
                await meta.storage.set('counter', null)
            }
            const c2 = await meta.storage.get('counter')
            if (typeof c === 'undefined') {
                await meta.storage.set('counter', 0)
            }
        }
        async function processEvent (event, meta) {
            const counter = await meta.storage.get('counter', 999)
            await meta.storage.set('counter', counter + 1)
            event.properties['counter'] = counter + 1
            return event
        }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)
    const event: PluginEvent = {
        ...defaultEvent,
        event: 'original event',
        properties: {},
    }

    await vm.methods.processEvent(event)
    expect(event.properties!['counter']).toEqual(1)

    await vm.methods.processEvent(event)
    expect(event.properties!['counter']).toEqual(2)

    await vm.methods.processEvent(event)
    expect(event.properties!['counter']).toEqual(3)
})

test('meta.cache expire', async () => {
    const indexJs = `
        async function setupPlugin(meta) {
            await meta.cache.set('counter', 0)
        }
        async function processEvent (event, meta) {
            const counter = await meta.cache.get('counter', 0)
            await meta.cache.set('counter', counter + 1)
            await meta.cache.expire('counter', 1)
            event.properties['counter'] = counter + 1
            return event
        }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)
    const event: PluginEvent = {
        ...defaultEvent,
        event: 'original event',
        properties: {},
    }

    await vm.methods.processEvent(event)
    expect(event.properties!['counter']).toEqual(1)

    await vm.methods.processEvent(event)
    expect(event.properties!['counter']).toEqual(2)

    await delay(1200)

    await vm.methods.processEvent(event)
    expect(event.properties!['counter']).toEqual(1)
})

test('meta.cache set ttl', async () => {
    const indexJs = `
        async function setupPlugin(meta) {
            await meta.cache.set('counter', 0)
        }
        async function processEvent (event, meta) {
            const counter = await meta.cache.get('counter', 0)
            await meta.cache.set('counter', counter + 1, 1)
            event.properties['counter'] = counter + 1
            return event
        }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)
    const event: PluginEvent = {
        ...defaultEvent,
        event: 'original event',
        properties: {},
    }

    await vm.methods.processEvent(event)
    expect(event.properties!['counter']).toEqual(1)

    await vm.methods.processEvent(event)
    expect(event.properties!['counter']).toEqual(2)

    await delay(1200)

    await vm.methods.processEvent(event)
    expect(event.properties!['counter']).toEqual(1)
})

test('meta.cache incr', async () => {
    const indexJs = `
        async function setupPlugin(meta) {
            await meta.cache.set('counter', 0)
        }
        async function processEvent (event, meta) {
            const counter = await meta.cache.incr('counter')
            event.properties['counter'] = counter
            return event
        }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)
    const event: PluginEvent = {
        ...defaultEvent,
        event: 'original event',
        properties: {},
    }

    await vm.methods.processEvent(event)
    expect(event.properties!['counter']).toEqual(1)

    await vm.methods.processEvent(event)
    expect(event.properties!['counter']).toEqual(2)

    await vm.methods.processEvent(event)
    expect(event.properties!['counter']).toEqual(3)
})

test('console.log', async () => {
    jest.spyOn(mockServer.db, 'createPluginLogEntry')

    const indexJs = `
        async function processEvent (event, meta) {
            console.log(event.event)
            return event
        }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)
    const event: PluginEvent = {
        ...defaultEvent,
        event: 'logged event',
    }

    await vm.methods.processEvent(event)

    expect(mockServer.db.createPluginLogEntry).toHaveBeenCalledWith(
        pluginConfig39,
        'CONSOLE',
        'LOG',
        'logged event',
        expect.anything()
    )
})

test('fetch', async () => {
    const indexJs = `
        async function processEvent (event, meta) {
            const response = await fetch('https://google.com/results.json?query=' + event.event)
            event.properties = await response.json()
            return event
        }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)
    const event: PluginEvent = {
        ...defaultEvent,
        event: 'fetched',
    }

    await vm.methods.processEvent(event)
    expect(fetch).toHaveBeenCalledWith('https://google.com/results.json?query=fetched')

    expect(event.properties).toEqual({ count: 2, query: 'bla', results: [true, true] })
})

test('fetch via import', async () => {
    const indexJs = `
        import importedFetch from 'node-fetch'
        async function processEvent (event, meta) {
            const response = await importedFetch('https://google.com/results.json?query=' + event.event)
            event.properties = await response.json()
            return event
        }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)
    const event: PluginEvent = {
        ...defaultEvent,
        event: 'fetched',
    }

    await vm.methods.processEvent(event)
    expect(fetch).toHaveBeenCalledWith('https://google.com/results.json?query=fetched')

    expect(event.properties).toEqual({ count: 2, query: 'bla', results: [true, true] })
})

test('fetch via require', async () => {
    const indexJs = `
        async function processEvent (event, meta) {
            const response = await require('node-fetch')('https://google.com/results.json?query=' + event.event)
            event.properties = await response.json()
            return event
        }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)
    const event: PluginEvent = {
        ...defaultEvent,
        event: 'fetched',
    }

    await vm.methods.processEvent(event)
    expect(fetch).toHaveBeenCalledWith('https://google.com/results.json?query=fetched')

    expect(event.properties).toEqual({ count: 2, query: 'bla', results: [true, true] })
})

test('attachments', async () => {
    const indexJs = `
        async function processEvent (event, meta) {
            event.properties = meta.attachments
            return event
        }
    `
    const attachments = {
        attachedFile: {
            content_type: 'application/json',
            file_name: 'plugin.json',
            contents: Buffer.from('{"name": "plugin"}'),
        },
    }
    const vm = await createPluginConfigVM(
        mockServer,
        {
            ...pluginConfig39,
            attachments,
        },
        indexJs
    )
    const event: PluginEvent = {
        ...defaultEvent,
        event: 'attachments',
    }

    await vm.methods.processEvent(event)

    expect(event.properties).toEqual(attachments)
})

test('runEvery', async () => {
    const indexJs = `
        function runEveryMinute (meta) {

        }
        function runEveryHour (meta) {

        }
        function runEveryDay (meta) {

        }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)

    expect(Object.keys(vm.tasks).sort()).toEqual(['job', 'schedule'])
    expect(Object.keys(vm.tasks.schedule)).toEqual(['runEveryMinute', 'runEveryHour', 'runEveryDay'])
    expect(Object.values(vm.tasks.schedule).map((v) => v?.name)).toEqual([
        'runEveryMinute',
        'runEveryHour',
        'runEveryDay',
    ])
    expect(Object.values(vm.tasks.schedule).map((v) => v?.type)).toEqual(['schedule', 'schedule', 'schedule'])
    expect(Object.values(vm.tasks.schedule).map((v) => typeof v?.exec)).toEqual(['function', 'function', 'function'])
})

test('runEvery must be a function', async () => {
    const indexJs = `
        function runEveryMinute(meta) {

        }
        const runEveryHour = false
        const runEveryDay = { some: 'object' }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)

    expect(Object.keys(vm.tasks.schedule)).toEqual(['runEveryMinute'])
    expect(Object.values(vm.tasks.schedule).map((v) => v?.name)).toEqual(['runEveryMinute'])
    expect(Object.values(vm.tasks.schedule).map((v) => v?.type)).toEqual(['schedule'])
    expect(Object.values(vm.tasks.schedule).map((v) => typeof v?.exec)).toEqual(['function'])
})

test('posthog in runEvery', async () => {
    const indexJs = `
        function runEveryMinute(meta) {
            posthog.capture('my-new-event', { random: 'properties' })
            return 'haha'
        }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)

    expect(Client).not.toHaveBeenCalled

    const response = await vm.tasks.schedule.runEveryMinute.exec()
    expect(response).toBe('haha')

    expect(Client).toHaveBeenCalledTimes(2)
    expect((Client as any).mock.calls[0][1]).toEqual(mockServer.CELERY_DEFAULT_QUEUE) // webhook to celery queue
    expect((Client as any).mock.calls[1][1]).toEqual(mockServer.PLUGINS_CELERY_QUEUE) // events out to start of plugin queue

    const mockClientInstance = (Client as any).mock.instances[1]
    const mockSendTask = mockClientInstance.sendTask

    expect(mockSendTask.mock.calls[0][0]).toEqual('posthog.tasks.process_event.process_event_with_plugins')
    expect(mockSendTask.mock.calls[0][1]).toEqual([
        'plugin-id-60',
        null,
        null,
        expect.objectContaining({
            distinct_id: 'plugin-id-60',
            event: 'my-new-event',
            properties: expect.objectContaining({
                $lib: 'posthog-plugin-server',
                random: 'properties',
                distinct_id: 'plugin-id-60',
            }),
        }),
        2,
        mockSendTask.mock.calls[0][1][5],
        mockSendTask.mock.calls[0][1][6],
    ])
    expect(mockSendTask.mock.calls[0][2]).toEqual({})
})

test('posthog in runEvery with timestamp', async () => {
    const indexJs = `
        function runEveryMinute(meta) {
            posthog.capture('my-new-event', { random: 'properties', timestamp: '2020-02-23T02:15:00Z' })
            return 'haha'
        }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)

    expect(Client).not.toHaveBeenCalled

    const response = await vm.tasks.schedule.runEveryMinute.exec()
    expect(response).toBe('haha')

    expect(Client).toHaveBeenCalledTimes(2)
    expect((Client as any).mock.calls[0][1]).toEqual(mockServer.CELERY_DEFAULT_QUEUE) // webhook to celery queue
    expect((Client as any).mock.calls[1][1]).toEqual(mockServer.PLUGINS_CELERY_QUEUE) // events out to start of plugin queue

    const mockClientInstance = (Client as any).mock.instances[1]
    const mockSendTask = mockClientInstance.sendTask

    expect(mockSendTask.mock.calls[0][0]).toEqual('posthog.tasks.process_event.process_event_with_plugins')
    expect(mockSendTask.mock.calls[0][1]).toEqual([
        'plugin-id-60',
        null,
        null,
        expect.objectContaining({
            timestamp: '2020-02-23T02:15:00Z', // taken out of the properties
            distinct_id: 'plugin-id-60',
            event: 'my-new-event',
            properties: expect.objectContaining({ $lib: 'posthog-plugin-server', random: 'properties' }),
        }),
        2,
        mockSendTask.mock.calls[0][1][5],
        mockSendTask.mock.calls[0][1][6],
    ])
    expect(mockSendTask.mock.calls[0][2]).toEqual({})
})

test('posthog.capture accepts user-defined distinct id', async () => {
    const indexJs = `
        function runEveryMinute(meta) {
            posthog.capture('my-new-event', { random: 'properties', distinct_id: 'custom id' })
            return 'haha'
        }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)

    expect(Client).not.toHaveBeenCalled

    const response = await vm.tasks.schedule.runEveryMinute.exec()
    expect(response).toBe('haha')

    const mockClientInstance = (Client as any).mock.instances[1]
    const mockSendTask = mockClientInstance.sendTask

    expect(mockSendTask.mock.calls[0][0]).toEqual('posthog.tasks.process_event.process_event_with_plugins')
    expect(mockSendTask.mock.calls[0][1]).toEqual([
        'custom id',
        null,
        null,
        expect.objectContaining({
            distinct_id: 'custom id',
            event: 'my-new-event',
            properties: expect.objectContaining({
                $lib: 'posthog-plugin-server',
                random: 'properties',
                distinct_id: 'custom id',
            }),
        }),
        2,
        mockSendTask.mock.calls[0][1][5],
        mockSendTask.mock.calls[0][1][6],
    ])
})

test('onEvent', async () => {
    const indexJs = `
        async function onEvent (event, meta) {
            await fetch('https://google.com/results.json?query=' + event.event)
        }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)
    const event: PluginEvent = {
        ...defaultEvent,
        event: 'onEvent',
    }
    await vm.methods.onEvent(event)
    expect(fetch).toHaveBeenCalledWith('https://google.com/results.json?query=onEvent')
})

test('onSnapshot', async () => {
    const indexJs = `
        async function onSnapshot (event, meta) {
            await fetch('https://google.com/results.json?query=' + event.event)
        }
    `
    await resetTestDatabase(indexJs)
    const vm = await createPluginConfigVM(mockServer, pluginConfig39, indexJs)
    const event: PluginEvent = {
        ...defaultEvent,
        event: '$snapshot',
    }
    await vm.methods.onSnapshot(event)
    expect(fetch).toHaveBeenCalledWith('https://google.com/results.json?query=$snapshot')
})

describe('exportEvents', () => {
    test('normal operation', async () => {
        const indexJs = `
            async function exportEvents (events, meta) {
                await fetch('https://export.com/results.json?query=' + events[0].event + '&events=' + events.length)
            }
        `
        await resetTestDatabase(indexJs)
        const vm = await createPluginConfigVM(
            mockServer,
            {
                ...pluginConfig39,
                config: {
                    ...pluginConfig39.config,
                    exportEventsBufferBytes: 10000,
                    exportEventsBufferSeconds: 1,
                    exportEventsToIgnore: defaultEvent.event,
                },
            },
            indexJs
        )
        const event: PluginEvent = {
            ...defaultEvent,
            event: 'exported',
        }
        await vm.methods.onEvent(event)
        await vm.methods.onEvent(defaultEvent)
        await vm.methods.onEvent(event)
        await delay(2000)
        expect(fetch).toHaveBeenCalledWith('https://export.com/results.json?query=exported&events=2')
    })

    test('retries', async () => {
        const indexJs = `
            async function exportEvents (events, meta) {
                meta.global.ranTimes = (meta.global.ranTimes || 0) + 1;
                if (meta.global.ranTimes < 3) {
                    throw new RetryError('Try again')
                } else {
                    await fetch('https://export.com/results.json?query=' + events[0].event + '&events=' + events.length)
                }
            }
        `
        await resetTestDatabase(indexJs, { WORKER_CONCURRENCY: 1, JOB_QUEUES: 'fs' })
        const vm = await createPluginConfigVM(
            mockServer,
            {
                ...pluginConfig39,
                config: {
                    ...pluginConfig39.config,
                    exportEventsBufferBytes: 10000,
                    exportEventsBufferSeconds: 1,
                    exportEventsToIgnore: '',
                },
            },
            indexJs
        )
        const event: PluginEvent = {
            ...defaultEvent,
            event: 'exported',
        }

        // first ones will fail and be retried
        await vm.methods.onEvent(event)
        await vm.methods.onEvent(event)
        await vm.methods.onEvent(event)
        await delay(1000)

        // get the enqueued job
        expect(JobQueueManager).toHaveBeenCalled()
        const mockJobQueueInstance = (JobQueueManager as any).mock.instances[0]
        const mockEnqueue = mockJobQueueInstance.enqueue
        expect(mockEnqueue).toHaveBeenCalledTimes(1)
        expect(mockEnqueue).toHaveBeenCalledWith({
            payload: { batch: [event, event, event], batchId: expect.any(Number), retriesPerformedSoFar: 1 },
            pluginConfigId: 39,
            pluginConfigTeam: 2,
            timestamp: expect.any(Number),
            type: 'exportEventsWithRetry',
        })
        const jobPayload = mockEnqueue.mock.calls[0][0].payload

        // run the job directly
        await vm.tasks.job['exportEventsWithRetry'].exec(jobPayload)

        // enqueued again
        expect(mockEnqueue).toHaveBeenCalledTimes(2)
        expect(mockEnqueue).toHaveBeenLastCalledWith({
            payload: { batch: jobPayload.batch, batchId: jobPayload.batchId, retriesPerformedSoFar: 2 },
            pluginConfigId: 39,
            pluginConfigTeam: 2,
            timestamp: expect.any(Number),
            type: 'exportEventsWithRetry',
        })
        const jobPayload2 = mockEnqueue.mock.calls[1][0].payload

        // run the job a second time
        await vm.tasks.job['exportEventsWithRetry'].exec(jobPayload2)

        // now it passed
        expect(fetch).toHaveBeenCalledWith('https://export.com/results.json?query=exported&events=3')
    })
})
