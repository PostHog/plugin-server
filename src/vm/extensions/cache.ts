import { CacheExtension } from '@posthog/plugin-scaffold'

import { PluginsServer } from '../../types'

export function createCache(server: PluginsServer, pluginId: number, teamId: number): CacheExtension {
    const getKey = (key: string) => `@plugin/${pluginId}/${typeof teamId === 'undefined' ? '@all' : teamId}/${key}`
    return {
        set: async function (key: string, value: unknown, ttlSeconds?: number, jsonStringify = true): Promise<void> {
            return await server.db.redisSet(getKey(key), value, ttlSeconds, jsonStringify)
        },
        get: async function (key: string, defaultValue: unknown, jsonParse = true): Promise<unknown> {
            return await server.db.redisGet(getKey(key), defaultValue, jsonParse)
        },
        incr: async function (key: string): Promise<number> {
            return await server.db.redisIncr(getKey(key))
        },
        expire: async function (key: string, ttlSeconds: number): Promise<boolean> {
            return await server.db.redisExpire(getKey(key), ttlSeconds)
        },
    }
}
