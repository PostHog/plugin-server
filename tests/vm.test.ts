import { createPluginConfigVM } from '../src/vm'
import { PluginConfig, PluginsServer, Plugin } from '../src/types'
import { PluginEvent } from 'posthog-plugins'
import { createServer } from '../src/server'
import * as fetch from 'node-fetch'
import { delay } from '../src/utils'
import Client from '../src/celery/client'

jest.mock('../src/celery/client')

const defaultEvent = {
    distinct_id: 'my_id',
    ip: '127.0.0.1',
    site_url: 'http://localhost',
    team_id: 3,
    now: new Date().toISOString(),
    event: 'default event',
}

let mockServer: PluginsServer

const mockPlugin: Plugin = {
    id: 4,
    plugin_type: 'custom',
    name: 'mock-plugin',
    description: 'Mock Plugin in Tests',
    url: 'http://plugins.posthog.com/mock-plugin',
    config_schema: {},
    tag: 'v1.0.0',
    archive: null,
    error: undefined,
}

const mockConfig: PluginConfig = {
    id: 4,
    team_id: 2,
    plugin: mockPlugin,
    plugin_id: mockPlugin.id,
    enabled: true,
    order: 0,
    config: { configKey: 'configValue' },
    error: undefined,
    attachments: {},
    vm: null,
}

beforeEach(async () => {
    ;(Client as any).mockClear()
    mockServer = (await createServer())[0]
})

afterEach(async () => {
    mockServer.redis.disconnect()
    await mockServer.db.end()
    jest.clearAllMocks()
})

test('empty plugins', async () => {
    const indexJs = ''
    const libJs = ''
    const vm = createPluginConfigVM(mockServer, mockConfig, indexJs, libJs)

    expect(Object.keys(vm).sort()).toEqual(['methods', 'tasks', 'vm'])
    expect(Object.keys(vm.methods).sort()).toEqual(['processEvent', 'processEventBatch'])
    expect(vm.methods.processEvent).toEqual(undefined)
    expect(vm.methods.processEventBatch).toEqual(undefined)
})

test('processEvent', async () => {
    const indexJs = `
        function processEvent (event, meta) {
            event.event = 'changed event'
            return event
        }  
    `
    const vm = createPluginConfigVM(mockServer, mockConfig, indexJs)
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
    const vm = createPluginConfigVM(mockServer, mockConfig, indexJs)
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
    const vm = createPluginConfigVM(mockServer, mockConfig, indexJs)
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
    const vm = createPluginConfigVM(mockServer, mockConfig, indexJs)
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
    const vm = createPluginConfigVM(mockServer, mockConfig, indexJs)
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
    const vm = createPluginConfigVM(mockServer, mockConfig, indexJs)
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
    const vm = createPluginConfigVM(mockServer, mockConfig, indexJs)

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
    const vm = createPluginConfigVM(mockServer, mockConfig, indexJs)

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
    const vm = createPluginConfigVM(mockServer, mockConfig, indexJs)

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
    const vm = createPluginConfigVM(mockServer, mockConfig, indexJs)
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
    const vm = createPluginConfigVM(mockServer, mockConfig, indexJs)
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
    const vm = createPluginConfigVM(mockServer, mockConfig, indexJs)
    const event: PluginEvent = {
        ...defaultEvent,
        event: 'original event',
        properties: {},
    }
    await vm.methods.processEvent(event)

    expect(event.properties).toEqual(mockConfig.config)
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
    const vm = createPluginConfigVM(mockServer, mockConfig, indexJs)
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
        async function processEvent (event, meta) {
            const counter = await meta.cache.get('counter', 0)
            await meta.cache.set('counter', counter + 1)
            await meta.cache.expire('counter', 1)
            event.properties['counter'] = counter + 1
            return event
        }
    `
    const vm = createPluginConfigVM(mockServer, mockConfig, indexJs)
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
        async function processEvent (event, meta) {
            const counter = await meta.cache.get('counter', 0)
            await meta.cache.set('counter', counter + 1, 1)
            event.properties['counter'] = counter + 1
            return event
        }
    `
    const vm = createPluginConfigVM(mockServer, mockConfig, indexJs)
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
        async function processEvent (event, meta) {
            const counter = await meta.cache.incr('counter')
            event.properties['counter'] = counter
            return event
        }
    `
    const vm = createPluginConfigVM(mockServer, mockConfig, indexJs)
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

test('lib.js (deprecated)', async () => {
    const indexJs = `
        async function processEvent (event, meta) {
            event.event = libraryFunction(event.event)
            return event
        }
    `
    const libJs = `
        function libraryFunction (string) {
            return string.split("").reverse().join("")
        }
    `
    const vm = createPluginConfigVM(mockServer, mockConfig, indexJs, libJs)
    const event: PluginEvent = {
        ...defaultEvent,
        event: 'original event',
    }
    await vm.methods.processEvent(event)

    expect(event.event).toEqual('tneve lanigiro')
})

test('console.log', async () => {
    console.log = jest.fn()
    console.error = jest.fn()
    console.warn = jest.fn()
    console.info = jest.fn()
    console.debug = jest.fn()
    const indexJs = `
        async function processEvent (event, meta) {
            console.log(event.event)
            console.error(event.event)
            console.warn(event.event)
            console.info(event.event)
            console.debug(event.event)
            return event
        }
    `
    const vm = createPluginConfigVM(mockServer, mockConfig, indexJs)
    const event: PluginEvent = {
        ...defaultEvent,
        event: 'logged event',
    }

    await vm.methods.processEvent(event)
    expect(console.log).toHaveBeenCalledWith('logged event')
    expect(console.error).toHaveBeenCalledWith('logged event')
    expect(console.warn).toHaveBeenCalledWith('logged event')
    expect(console.info).toHaveBeenCalledWith('logged event')
    expect(console.debug).toHaveBeenCalledWith('logged event')
})

test('fetch', async () => {
    const indexJs = `
        async function processEvent (event, meta) {
            const response = await fetch('https://google.com/results.json?query=' + event.event)
            event.properties = await response.json()
            return event             
        }
    `
    const vm = createPluginConfigVM(mockServer, mockConfig, indexJs)
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
    const vm = createPluginConfigVM(
        mockServer,
        {
            ...mockConfig,
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
        function runEveryMinute(meta) {
            
        }
        function runEveryHour(meta) {
            
        }
        function runEveryDay(meta) {
            
        }
    `
    const vm = createPluginConfigVM(mockServer, mockConfig, indexJs)

    expect(Object.keys(vm.tasks)).toEqual(['runEveryMinute', 'runEveryHour', 'runEveryDay'])
    expect(Object.values(vm.tasks).map((v) => v?.name)).toEqual(['runEveryMinute', 'runEveryHour', 'runEveryDay'])
    expect(Object.values(vm.tasks).map((v) => v?.type)).toEqual(['runEvery', 'runEvery', 'runEvery'])
    expect(Object.values(vm.tasks).map((v) => typeof v?.exec)).toEqual(['function', 'function', 'function'])
})

test('runEvery must be a function', async () => {
    const indexJs = `
        function runEveryMinute(meta) {
            
        }
        const runEveryHour = false
        const runEveryDay = { some: 'object' }
    `
    const vm = createPluginConfigVM(mockServer, mockConfig, indexJs)

    expect(Object.keys(vm.tasks)).toEqual(['runEveryMinute'])
    expect(Object.values(vm.tasks).map((v) => v?.name)).toEqual(['runEveryMinute'])
    expect(Object.values(vm.tasks).map((v) => v?.type)).toEqual(['runEvery'])
    expect(Object.values(vm.tasks).map((v) => typeof v?.exec)).toEqual(['function'])
})

test('posthog in runEvery', async () => {
    const indexJs = `
        function runEveryMinute(meta) {
            posthog.capture('my-new-event', { random: 'properties' })
            return 'haha'
        }
    `
    const vm = createPluginConfigVM(mockServer, mockConfig, indexJs)

    expect(Client).not.toHaveBeenCalled

    const response = await vm.tasks.runEveryMinute.exec()
    expect(response).toBe('haha')

    expect(Client).toHaveBeenCalledTimes(1)
    expect((Client as any).mock.calls[0][1]).toEqual(mockServer.PLUGINS_CELERY_QUEUE)

    const mockClientInstance = (Client as any).mock.instances[0]
    const mockSendTask = mockClientInstance.sendTask

    expect(mockSendTask.mock.calls[0][0]).toEqual('posthog.tasks.process_event.process_event')
    expect(mockSendTask.mock.calls[0][1]).toEqual([])
    const sentEvent = mockSendTask.mock.calls[0][2]
    expect(Object.keys(sentEvent).sort()).toEqual([
        'data',
        'distinct_id',
        'ip',
        'now',
        'sent_at',
        'site_url',
        'team_id',
    ])
    expect(Object.keys(sentEvent.data).sort()).toEqual(['distinct_id', 'event', 'properties', 'timestamp'])
    expect(Object.keys(sentEvent.data.properties).sort()).toEqual(['$lib', '$lib_version', 'random'])
    console.log(sentEvent)
    expect(sentEvent).toEqual(
        expect.objectContaining({
            data: expect.objectContaining({
                distinct_id: 'mock-plugin (4)',
                event: 'my-new-event',
                properties: expect.objectContaining({ $lib: 'posthog-plugin-server', random: 'properties' }),
            }),
            distinct_id: 'mock-plugin (4)',
            ip: null,
            site_url: null,
            team_id: 2,
        })
    )
})
