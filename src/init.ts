import { PluginsServerConfig } from './types'
import { setLogLevel } from './utils'
import * as Sentry from '@sentry/node'

// Must require as `tsc` strips unused `import` statements and just requiring this seems to init some globals
require('@sentry/tracing')

// Code that runs on app start, in both the main and worker threads
export function initApp(config: PluginsServerConfig): void {
    setLogLevel(config.LOG_LEVEL)

    if (config.SENTRY_DSN) {
        Sentry.init({
            dsn: config.SENTRY_DSN,
            tracesSampleRate: 0.05, // Only trace 5% of events
        })
    }
}
