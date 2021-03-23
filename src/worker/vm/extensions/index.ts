import { CacheExtension, ConsoleExtension, StorageExtension } from '@posthog/plugin-scaffold'
import fetch, { RequestInfo, RequestInit, Response } from 'node-fetch'

import { PluginConfig, PluginsServer } from '../../../types'
import { createCache } from './cache'
import { createConsole } from './console'
import { createGoogle, DummyGoogle } from './google'
import { createPosthog, DummyPostHog } from './posthog'
import { createStorage } from './storage'

export interface Extensions {
    fetch: (url: RequestInfo, init?: RequestInit) => Promise<Response>
    cache: CacheExtension
    console: ConsoleExtension
    google: DummyGoogle
    posthog: DummyPostHog
    storage: StorageExtension
}

export function createExtensions(server: PluginsServer, pluginConfig: PluginConfig): Extensions {
    return {
        fetch: async (url, init) => await fetch(url, init),
        cache: createCache(server, pluginConfig.plugin_id, pluginConfig.team_id),
        console: createConsole(),
        google: createGoogle(),
        posthog: createPosthog(server, pluginConfig),
        storage: createStorage(server, pluginConfig),
    }
}
