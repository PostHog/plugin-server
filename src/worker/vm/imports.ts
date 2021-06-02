import { BigQuery } from '@google-cloud/bigquery'
import * as contrib from '@posthog/plugin-contrib'
import * as scaffold from '@posthog/plugin-scaffold'
import * as AWS from 'aws-sdk'
import crypto from 'crypto'
import dns from 'dns'
import * as genericPool from 'generic-pool'
import ipRangeCheck from 'ip-range-check'
import net from 'net'
import nodeFetch, { RequestInit } from 'node-fetch'
import pg from 'pg'
import snowflake from 'snowflake-sdk'
import url from 'url'
import * as zlib from 'zlib'

import { IllegalOperationError } from './../plugins/run'
import { writeToFile } from './extensions/test-utils'

interface URLLike {
    href: string
}

// ['93.184.216.34', '172.31.0.0/16']
const RESTRICTED_IP_RANGES =
    process.env.NODE_ENV === 'test'
        ? ['127.0.0.1/8', '116.203.255.68']
        : (process.env.RESTRICTED_IP_RANGES || '').split(',')

const isIpInRestrictedRange = (ip: string): boolean => {
    return ipRangeCheck(ip, RESTRICTED_IP_RANGES)
}

const validateHostOrUrl = async (hostOrUrl: any) => {
    if (typeof hostOrUrl !== 'string') {
        throw new IllegalOperationError(`Invalid host/URL ${hostOrUrl}: Not a string or URLLike object`)
    }

    if (net.isIP(hostOrUrl) && isIpInRestrictedRange(hostOrUrl)) {
        throw new IllegalOperationError(`IP ${hostOrUrl} is not allowed for security reasons`)
    }

    if (hostOrUrl.startsWith('http://localhost')) {
        throw new IllegalOperationError(`${hostOrUrl} is not allowed for security reasons`)
    }

    const parsedHost = url.parse(hostOrUrl).hostname
    if (!parsedHost) {
        throw new IllegalOperationError(`Could not find a hostname for ${hostOrUrl}`)
    }

    const lookupResult = await dns.promises.lookup(parsedHost)
    if (isIpInRestrictedRange(lookupResult.address)) {
        throw new IllegalOperationError(`IP ${lookupResult.address} is not allowed for security reasons`)
    }
}

export const fetch = async (url: string | URLLike, init?: RequestInit) => {
    if (typeof url === 'object' && 'href' in url) {
        url = url.href
    }
    await checkRedirectChain(url)
    return await nodeFetch(url, init)
}

const checkRedirectChain = async (
    url: string,
    originalUrl: string = url,
    numberOfRedirectsFollowed = 0,
    setOfRedirectsFollowed: Set<string> = new Set()
) => {
    if (numberOfRedirectsFollowed >= 10 || setOfRedirectsFollowed.has(url)) {
        throw new IllegalOperationError(`${originalUrl} flagged as unsafe after too many redirects`)
    }
    await validateHostOrUrl(url)
    if (process.env.NODE_ENV === 'test') {
        return
    }
    const res = await nodeFetch(url, { redirect: 'manual' })
    if (res.headers && res.headers.get('location')) {
        setOfRedirectsFollowed.add(res.headers.get('location')!)
        await checkRedirectChain(
            res.headers.get('location')!,
            originalUrl,
            numberOfRedirectsFollowed + 1,
            setOfRedirectsFollowed
        )
    }
}

export const imports = {
    crypto: crypto,
    zlib: zlib,
    'generic-pool': genericPool,
    'node-fetch': fetch,
    'snowflake-sdk': snowflake,
    '@google-cloud/bigquery': { BigQuery },
    '@posthog/plugin-scaffold': scaffold,
    '@posthog/plugin-contrib': contrib,
    'aws-sdk': AWS,
    pg: pg,
    ...(process.env.NODE_ENV === 'test'
        ? {
              'test-utils/write-to-file': writeToFile,
          }
        : {}),
}
