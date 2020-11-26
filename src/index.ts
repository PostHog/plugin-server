import yargs from 'yargs'
import { PluginsServerConfig } from './types'
import { startPluginsServer } from './server'
import { startIngestionServer } from 'ingestion/server'

yargs
    .scriptName('posthog-plugins')
    .option('config', { alias: 'c', describe: 'Config options JSON.', type: 'string' })
    .option('ingest', { alias: 'i', describe: 'Whether ingestion server should be started.', type: 'boolean' })
    .option('ingestionPort', { alias: 'p', describe: 'Ingestion server port.', type: 'number' })
    .option('ingestionHostname', { alias: 'h', describe: 'Ingestion server hostname.', type: 'string' })
    .command(['start', '$0'], 'start the server', ({ argv: { config, ingest, ingestionPort, ingestionHostname } }) => {
        const parsedConfig: PluginsServerConfig = config ? JSON.parse(config) : {}
        startPluginsServer(parsedConfig)
        if (ingest) startIngestionServer(ingestionPort, ingestionHostname)
    })
    .help().argv
