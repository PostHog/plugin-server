import { CacheExtension } from '@posthog/plugin-scaffold'

import { Hub } from '../../../types'

export function createCache(server: Hub, pluginId: number, teamId: number): CacheExtension {
    const getKey = (key: string) => `@plugin/${pluginId}/${typeof teamId === 'undefined' ? '@all' : teamId}/${key}`
    return {
        set: async function (key, value, ttlSeconds, options) {
            return await server.db.redisSet(getKey(key), value, ttlSeconds, options)
        },
        get: async function (key, defaultValue, options) {
            return await server.db.redisGet(getKey(key), defaultValue, options)
        },
        incr: async function (key) {
            return await server.db.redisIncr(getKey(key))
        },
        expire: async function (key, ttlSeconds) {
            return await server.db.redisExpire(getKey(key), ttlSeconds)
        },
        lpush: async function (key, elementOrArray) {
            const isString = typeof elementOrArray === 'string'
            if (!Array.isArray(elementOrArray) && !isString) {
                throw new Error('cache.lpush expects a string value or an array of strings')
            }
            if (!isString) {
                elementOrArray = elementOrArray.map((el) => String(el))
            }
            return await server.db.redisLPush(getKey(key), elementOrArray, { jsonSerialize: false })
        },
        lrange: async function (key, startIndex, endIndex) {
            if (typeof startIndex !== 'number' || typeof endIndex !== 'number') {
                throw new Error('cache.lrange expects a number for the start and end indexes')
            }
            return await server.db.redisLRange(getKey(key), startIndex, endIndex)
        },
    }
}
