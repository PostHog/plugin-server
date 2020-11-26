import yargs from 'yargs'
import { PluginsServerConfig } from './types'
import { startPluginsServer } from './server'
import { startWebServer } from './web/server'

yargs
    .scriptName('posthog-plugins')
    .option('config', { alias: 'c', describe: 'Config options JSON.', type: 'string' })
    .option('disableWeb', { describe: 'Whether web server should be disabled.', type: 'boolean' })
    .option('webPort', { alias: 'p', describe: 'Web server port.', type: 'number' })
    .option('webHostname', { alias: 'h', describe: 'Web server hostname.', type: 'string' })
    .help()
    .command({
        command: ['start', '$0'],
        describe: 'start the server',
        handler: ({ config, disableWeb, webPort, webHostname }: Record<string, string>) => {
            const parsedConfig: PluginsServerConfig = config ? JSON.parse(config) : {}
            startPluginsServer(parsedConfig)
            if (!disableWeb) {
                startWebServer(webPort, webHostname)
            }
        },
    }).argv
