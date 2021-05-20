import { BigQuery } from '@google-cloud/bigquery'
import * as contrib from '@posthog/plugin-contrib'
import * as AWS from 'aws-sdk'
import crypto from 'crypto'
import dns from 'dns'
import * as genericPool from 'generic-pool'
import ipRangeCheck from 'ip-range-check'
import net from 'net'
import nodeFetch, { RequestInit } from 'node-fetch'
import nodePostgres from 'pg'
import { parse } from 'pg-connection-string'
import snowflake from 'snowflake-sdk'
import url from 'url'
import * as zlib from 'zlib'

import { IllegalOperationError } from './../plugins/run'
import { writeToFile } from './extensions/test-utils'

interface URLLike {
    href: string
}

// 93.184.216.34 = example.com
const RESTRICTED_IP_RANGES = ['93.184.216.34', '172.31.0.0/16']

const isIpInRestrictedRange = (ip: string): boolean => {
    if (ip.startsWith('127') || ip === '0.0.0.0') {
        return true
    }
    for (const range of RESTRICTED_IP_RANGES) {
        if (ipRangeCheck(ip, range)) {
            return true
        }
    }
    return false
}

const validateHostOrUrl = async (hostOrUrl: any) => {
    if (typeof hostOrUrl !== 'string') {
        throw new IllegalOperationError(`Invalid host/URL ${hostOrUrl}: Not a string or URLLike object`)
    }

    if (net.isIP(hostOrUrl) && isIpInRestrictedRange(hostOrUrl)) {
        throw new IllegalOperationError(`IP ${hostOrUrl} is not allowed for security reasons`)
    }

    if (hostOrUrl.includes('localhost') || net.isIP(hostOrUrl)) {
        throw new IllegalOperationError(`${hostOrUrl} is not allowed for security reasons`)
    }

    const parsedHost = url.parse(hostOrUrl).hostname
    if (!parsedHost) {
        throw new IllegalOperationError(`Could not find a hostname for ${hostOrUrl}`)
    }

    const lookupResult = await dns.promises.lookup(parsedHost)
    if (isIpInRestrictedRange(lookupResult.address)) {
        throw new IllegalOperationError(`IP ${lookupResult} is not allowed for security reasons`)
    }
}

const fetch = async (url: string | URLLike, init?: RequestInit) => {
    if (typeof url === 'object' && 'href' in url) {
        url = url.href
    }
    await validateHostOrUrl(url)
    return await nodeFetch(url, init)
}

class Client extends nodePostgres.Client {
    constructor(config: string | nodePostgres.ClientConfig) {
        let database: string
        if (typeof config === 'string') {
            database = parse(config).database || ''
        } else {
            database = config.database || ''
        }
        if (database === 'posthog') {
            throw new IllegalOperationError('Database name posthog not allowed')
        }
        super(config)
    }
}

export const imports = {
    crypto: crypto,
    zlib: zlib,
    'generic-pool': genericPool,
    'node-fetch': fetch,
    'snowflake-sdk': snowflake,
    '@google-cloud/bigquery': { BigQuery },
    '@posthog/plugin-contrib': contrib,
    'aws-sdk': AWS,
    pg: { Client },
    ...(process.env.NODE_ENV === 'test'
        ? {
              'test-utils/write-to-file': writeToFile,
          }
        : {}),
}
