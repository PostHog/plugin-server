import { setupPlugins } from '../plugins'
import { defaultConfig } from '../server'
import { Pool } from 'pg'
import * as Redis from 'ioredis'
import { PluginsServer } from '../types'

jest.mock('../sql', () => ({
    getPluginRows: jest.fn(async () => [{ id: 22, error: 'yeah' }]),
    getPluginAttachmentRows: jest.fn(async () => [{ id: 22, error: 'yeah' }]),
    getPluginConfigRows: jest.fn(async () => [{ id: 22, error: 'yeah' }]),
}))

let mockServer: PluginsServer
beforeEach(async () => {
    mockServer = {
        ...defaultConfig,
        db: new Pool(),
        redis: new Redis('redis://mockmockmock/'),
    }
})

test('setupPlugins', async () => {
    // console.log('bla')
    // await setupPlugins(mockServer)
})
