import { BigQuery } from '@google-cloud/bigquery'
import * as contrib from '@posthog/plugin-contrib'
import * as AWS from 'aws-sdk'
import crypto from 'crypto'
import dns from 'dns'
import * as genericPool from 'generic-pool'
import nodeFetch from 'node-fetch'
import nodePostgres from 'pg'
import { parse } from 'pg-connection-string'
import snowflake from 'snowflake-sdk'
import url from 'url'
import * as zlib from 'zlib'

import { writeToFile } from './extensions/test-utils'

// 93.184.216.34 = example.com
const RESTRICTED_IPS = ['93.184.216.34']

const isIpv4 = (str: string) =>
    /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(
        str
    )
const isIpv6 = (str: string) =>
    /(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))/.test(
        str
    )

const validateHostOrUrl = async (hostOrUrl: any) => {
    if (typeof hostOrUrl != 'string') {
        throw new Error(`Invalid host/URL ${hostOrUrl}`)
    }
    if (
        (hostOrUrl.includes('amazonaws.com') && !hostOrUrl.includes('redshift.amazonaws.com')) ||
        hostOrUrl.includes('localhost') ||
        hostOrUrl.includes('posthog.net') ||
        isIpv4(hostOrUrl) ||
        isIpv6(hostOrUrl)
    ) {
        throw new Error(`Host ${hostOrUrl} is not allowed`)
    }

    const parsedHost = url.parse(hostOrUrl).hostname

    if (!parsedHost) {
        throw new Error(`Invalid hostname for ${hostOrUrl}`)
    }

    const lookupResult = await dns.promises.lookup(parsedHost)

    if (RESTRICTED_IPS.includes(lookupResult.address)) {
        throw new Error(`Host ${parsedHost} is not allowed`)
    }
}

const fetch = async (url: string, ...args: any) => {
    await validateHostOrUrl(url)
    return await nodeFetch(url, ...args)
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
            throw new Error('Database name posthog not allowed')
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
