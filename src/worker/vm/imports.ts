import { BigQuery } from '@google-cloud/bigquery'
import * as contrib from '@posthog/plugin-contrib'
import * as AWS from 'aws-sdk'
import crypto from 'crypto'
import * as genericPool from 'generic-pool'
import nodeFetch from 'node-fetch'
import nodePostgres from 'pg'
import { parse } from 'pg-connection-string'
import snowflake from 'snowflake-sdk'
import * as zlib from 'zlib'

import { writeToFile } from './extensions/test-utils'

const isIpv4 = (str: string) =>
    /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(
        str
    )
const isIpv6 = (str: string) =>
    /(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))/.test(
        str
    )

const validateHostOrUrl = (hostOrUrl: any) => {
    if (typeof hostOrUrl != 'string') {
        throw new Error('URL/Host must be a string!')
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
}

const fetch = async (url: string, ...args: any) => {
    validateHostOrUrl(url)
    return await nodeFetch(url, ...args)
}

class Client extends nodePostgres.Client {
    constructor(config: string | nodePostgres.ClientConfig) {
        if (typeof config === 'string') {
            const host = parse(config).host || ''
            validateHostOrUrl(host)
        } else {
            validateHostOrUrl(config.host)
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
