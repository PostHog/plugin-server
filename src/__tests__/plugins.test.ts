import { runPlugins, setupPlugins } from '../plugins'
import { defaultConfig } from '../server'
import { Pool } from 'pg'
import * as Redis from 'ioredis'
import { Plugin, PluginAttachmentDB, PluginConfig, PluginError, PluginsServer } from '../types'
import * as s from '../sql'
import * as AdmZip from 'adm-zip'
import { PluginEvent } from 'posthog-plugins/src/types'

jest.mock('../sql')
type UnPromisify<F> = F extends (...args: infer A) => Promise<infer T> ? (...args: A) => T : never
const getPluginRows = (s.getPluginRows as unknown) as jest.MockedFunction<UnPromisify<typeof s.getPluginRows>>
const getPluginAttachmentRows = (s.getPluginAttachmentRows as unknown) as jest.MockedFunction<
    UnPromisify<typeof s.getPluginAttachmentRows>
>
const getPluginConfigRows = (s.getPluginConfigRows as unknown) as jest.MockedFunction<
    UnPromisify<typeof s.getPluginConfigRows>
>
const setError = (s.setError as unknown) as jest.MockedFunction<UnPromisify<typeof s.setError>>

// Tests missing:
// - load local "file:" plugins
// - how various errors during load are handled (broken index, broken zip, broken json, etc)
// - global plugins (need to be discussed how to implement)
// - lib.js loading, even if deprecated

function createArchive(name: string, { indexJs, pluginJson }: { indexJs?: string; pluginJson?: string }): Buffer {
    const zip = new AdmZip()
    if (indexJs) {
        zip.addFile('testplugin/index.js', Buffer.alloc(indexJs.length, indexJs))
    }
    if (pluginJson) {
        zip.addFile('testplugin/plugin.json', Buffer.alloc(pluginJson.length, pluginJson))
    } else {
        zip.addFile(
            'testplugin/plugin.json',
            new Buffer(
                JSON.stringify({
                    name,
                    description: 'just for testing',
                    url: 'http://example.com/plugin',
                    config: {},
                    main: 'index.js',
                })
            )
        )
    }
    return zip.toBuffer()
}

const plugin60: Plugin = {
    id: 60,
    name: 'posthog-maxmind-plugin',
    description: 'Ingest GeoIP data via MaxMind',
    url: 'https://www.npmjs.com/package/posthog-maxmind-plugin',
    config_schema: {
        localhostIP: {
            hint: 'Useful if testing locally',
            name: 'IP to use instead of 127.0.0.1',
            type: 'string',
            order: 2,
            default: '',
            required: false,
        },
        maxmindMmdb: {
            hint: 'The "GeoIP2 City" or "GeoLite2 City" database file',
            name: 'GeoIP .mddb database',
            type: 'attachment',
            order: 1,
            markdown:
                'Sign up for a [MaxMind.com](https://www.maxmind.com) account, download and extract the database and then upload the `.mmdb` file below',
            required: true,
        },
    },
    tag: '0.0.2',
    archive: createArchive('posthog-maxmind-plugin', {
        indexJs:
            'function processEvent (event) { if (event.properties) { event.properties.processed = true } return event }',
    }),
    error: undefined,
}

const pluginAttachment1: PluginAttachmentDB = {
    id: 1,
    key: 'maxmindMmdb',
    content_type: 'application/octet-stream',
    file_name: 'test.txt',
    file_size: 4,
    contents: Buffer.from('test'),
    plugin_config_id: 39,
    team_id: 2,
}

const pluginConfig39: PluginConfig = {
    id: 39,
    team_id: 2,
    plugin_id: 60,
    enabled: true,
    order: 0,
    config: { localhostIP: '94.224.212.175' },
    error: undefined,
}

const mockPluginIndex = (indexJs: string, pluginJson?: string) => ({
    ...plugin60,
    archive: createArchive('posthog-maxmind-plugin', { indexJs, pluginJson }),
})

let mockServer: PluginsServer
beforeEach(async () => {
    mockServer = {
        ...defaultConfig,
        db: new Pool(),
        redis: new Redis('redis://mockmockmock/'),
    }
})

test('setupPlugins and runPlugins', async () => {
    getPluginRows.mockReturnValueOnce([plugin60])
    getPluginAttachmentRows.mockReturnValueOnce([pluginAttachment1])
    getPluginConfigRows.mockReturnValueOnce([pluginConfig39])

    const { plugins, pluginConfigs, pluginConfigsPerTeam, defaultConfigs } = await setupPlugins(mockServer)

    expect(getPluginRows).toHaveBeenCalled()
    expect(getPluginAttachmentRows).toHaveBeenCalled()
    expect(getPluginConfigRows).toHaveBeenCalled()
    expect(setError).toHaveBeenCalled()

    expect(defaultConfigs).toEqual([])
    expect(Array.from(plugins.entries())).toEqual([[60, plugin60]])
    expect(Array.from(pluginConfigs.keys())).toEqual([39])

    const pluginConfig = pluginConfigs.get(39)!
    expect(pluginConfig.id).toEqual(pluginConfig39.id)
    expect(pluginConfig.team_id).toEqual(pluginConfig39.team_id)
    expect(pluginConfig.plugin_id).toEqual(pluginConfig39.plugin_id)
    expect(pluginConfig.enabled).toEqual(pluginConfig39.enabled)
    expect(pluginConfig.order).toEqual(pluginConfig39.order)
    expect(pluginConfig.config).toEqual(pluginConfig39.config)
    expect(pluginConfig.error).toEqual(pluginConfig39.error)

    expect(pluginConfig.plugin).toEqual(plugin60)
    expect(pluginConfig.attachments).toEqual({
        maxmindMmdb: {
            content_type: pluginAttachment1.content_type,
            file_name: pluginAttachment1.file_name,
            contents: pluginAttachment1.contents,
        },
    })
    expect(pluginConfig.vm).toBeDefined()
    expect(Object.keys(pluginConfig.vm!.methods)).toEqual(['processEvent'])

    const processEvent = pluginConfig.vm!.methods['processEvent']
    const event = { event: '$test', properties: {}, team_id: 2 } as PluginEvent
    await processEvent(event)

    expect(event.properties!['processed']).toEqual(true)

    event.properties!['processed'] = false

    const returnedEvent = await runPlugins(mockServer, event)
    expect(event.properties!['processed']).toEqual(true)
    expect(returnedEvent!.properties!['processed']).toEqual(true)
})

test('plugin returns null', async () => {
    getPluginRows.mockReturnValueOnce([mockPluginIndex('function processEvent (event, meta) { return null }')])
    getPluginConfigRows.mockReturnValueOnce([pluginConfig39])
    getPluginAttachmentRows.mockReturnValueOnce([])

    await setupPlugins(mockServer)

    const event = { event: '$test', properties: {}, team_id: 2 } as PluginEvent
    const returnedEvent = await runPlugins(mockServer, event)

    expect(returnedEvent).toEqual(null)
})

test('plugin meta has what it should have', async () => {
    getPluginRows.mockReturnValueOnce([
        mockPluginIndex(`
            function setupPlugin (meta) { meta.global.key = 'value' } 
            function processEvent (event, meta) { event.properties=meta; return event }
        `),
    ])
    getPluginConfigRows.mockReturnValueOnce([pluginConfig39])
    getPluginAttachmentRows.mockReturnValueOnce([pluginAttachment1])

    await setupPlugins(mockServer)

    const event = { event: '$test', properties: {}, team_id: 2 } as PluginEvent
    const returnedEvent = await runPlugins(mockServer, event)

    expect(Object.keys(returnedEvent!.properties!).sort()).toEqual(['attachments', 'cache', 'config', 'global'])
    expect(returnedEvent!.properties!['attachments']).toEqual({
        maxmindMmdb: { content_type: 'application/octet-stream', contents: Buffer.from('test'), file_name: 'test.txt' },
    })
    expect(returnedEvent!.properties!['config']).toEqual({ localhostIP: '94.224.212.175' })
    expect(returnedEvent!.properties!['global']).toEqual({ key: 'value' })
})

test('plugin with broken index.js does not do much', async () => {
    // silence some spam
    console.log = jest.fn()
    console.error = jest.fn()

    getPluginRows.mockReturnValueOnce([
        mockPluginIndex(`
            function setupPlugin (met
        `),
    ])
    getPluginConfigRows.mockReturnValueOnce([pluginConfig39])
    getPluginAttachmentRows.mockReturnValueOnce([pluginAttachment1])

    const { pluginConfigs } = await setupPlugins(mockServer)

    const event = { event: '$test', properties: {}, team_id: 2 } as PluginEvent
    const returnedEvent = await runPlugins(mockServer, { ...event })
    expect(returnedEvent).toEqual(event)

    expect(setError).toHaveBeenCalled()
    expect(setError.mock.calls[0][0]).toEqual(mockServer)
    expect(setError.mock.calls[0][1]!.message).toEqual("Unexpected token ';'")
    expect(setError.mock.calls[0][1]!.name).toEqual('SyntaxError')
    expect(setError.mock.calls[0][1]!.stack).toContain('vm.js:')
    expect(setError.mock.calls[0][1]!.time).toBeDefined()
    expect(setError.mock.calls[0][2]).toEqual(pluginConfigs.get(39))
    expect(pluginConfigs.get(39)!.vm).toEqual(null)
})

test('plugin with broken plugin.json does not do much', async () => {
    // silence some spam
    console.log = jest.fn()
    console.error = jest.fn()

    getPluginRows.mockReturnValueOnce([
        mockPluginIndex(
            `function processEvent (event, meta) { event.properties.processed = true; return event }`,
            '{ broken: "plugin.json" -=- '
        ),
    ])
    getPluginConfigRows.mockReturnValueOnce([pluginConfig39])
    getPluginAttachmentRows.mockReturnValueOnce([pluginAttachment1])

    const { pluginConfigs } = await setupPlugins(mockServer)

    expect(setError).toHaveBeenCalled()
    expect(setError.mock.calls[0][0]).toEqual(mockServer)
    expect(setError.mock.calls[0][1]!.message).toEqual('Can not load plugin.json for plugin "posthog-maxmind-plugin"')
    expect(setError.mock.calls[0][1]!.time).toBeDefined()
    expect(pluginConfigs.get(39)!.vm).toEqual(null)
})

test('plugin with http urls must have an archive', async () => {
    // silence some spam
    console.log = jest.fn()
    console.error = jest.fn()

    getPluginRows.mockReturnValueOnce([{ ...plugin60, archive: null }])
    getPluginConfigRows.mockReturnValueOnce([pluginConfig39])
    getPluginAttachmentRows.mockReturnValueOnce([pluginAttachment1])

    const { pluginConfigs } = await setupPlugins(mockServer)

    expect(pluginConfigs.get(39)!.plugin!.url).toContain('https://')
    expect(setError).toHaveBeenCalled()
    expect(setError.mock.calls[0][0]).toEqual(mockServer)
    expect(setError.mock.calls[0][1]!.message).toEqual('Un-downloaded remote plugins not supported!')
    expect(setError.mock.calls[0][1]!.time).toBeDefined()
    expect(pluginConfigs.get(39)!.vm).toEqual(null)
})
