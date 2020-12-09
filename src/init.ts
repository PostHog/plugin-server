import { PluginsServerConfig } from './types'
import { setLogLevel } from './utils'
import * as Sentry from '@sentry/node'
import * as Tracing from '@sentry/tracing' // unused import, yet importing inits globals

export function initApp(config: PluginsServerConfig) {
    setLogLevel(config.LOG_LEVEL)

    if (config.SENTRY_DSN) {
        Sentry.init({
            dsn: config.SENTRY_DSN,
            // We recommend adjusting this value in production, or using tracesSampler for finer control
            tracesSampleRate: 1.0,
        })
    }
}
