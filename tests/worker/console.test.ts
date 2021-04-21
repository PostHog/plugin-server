import { ConsoleExtension } from '@posthog/plugin-scaffold'
import { mocked } from 'ts-jest/utils'

import { createServer } from '../../src/shared/server'
import { getPluginConfigRows } from '../../src/shared/sql'
import { code } from '../../src/shared/utils'
import { PluginLogEntryType, PluginsServer } from '../../src/types'
import { TeamManager } from '../../src/worker/ingestion/team-manager'
import { createConsole } from '../../src/worker/vm/extensions/console'
import { resetTestDatabase } from '../helpers/sql'

describe('console extension', () => {
    let server: PluginsServer
    let closeServer: () => Promise<void>

    beforeEach(async () => {
        ;[server, closeServer] = await createServer()
        await resetTestDatabase()
    })

    afterEach(async () => {
        await closeServer()
    })

    Object.values(PluginLogEntryType).map((type) => {
        const method = type.toLowerCase() as keyof ConsoleExtension
        describe(`console#${method}`, () => {
            if (!server.ENABLE_PERSISTENT_CONSOLE) {
                // TODO: remove this return
                return
            }
            it('leaves an empty entry in the database', async () => {
                const pluginConfig = (await getPluginConfigRows(server))[0]

                const console = createConsole(server, pluginConfig)

                await ((console[method]() as unknown) as Promise<void>)

                const pluginLogEntries = await server.db.fetchPluginLogEntries()

                expect(pluginLogEntries.length).toBe(1)
                expect(pluginLogEntries[0].type).toEqual(type)
                expect(pluginLogEntries[0].message).toEqual('')
            })

            it('leaves a string + number entry in the database', async () => {
                const pluginConfig = (await getPluginConfigRows(server))[0]

                const console = createConsole(server, pluginConfig)

                await ((console[method]('number =', 987) as unknown) as Promise<void>)

                const pluginLogEntries = await server.db.fetchPluginLogEntries()

                expect(pluginLogEntries.length).toBe(1)
                expect(pluginLogEntries[0].type).toEqual(type)
                expect(pluginLogEntries[0].message).toEqual('number = 987')
            })

            it('leaves an error entry in the database', async () => {
                const pluginConfig = (await getPluginConfigRows(server))[0]

                const console = createConsole(server, pluginConfig)

                await ((console[method](new Error('something')) as unknown) as Promise<void>)

                const pluginLogEntries = await server.db.fetchPluginLogEntries()

                expect(pluginLogEntries.length).toBe(1)
                expect(pluginLogEntries[0].type).toEqual(type)
                expect(pluginLogEntries[0].message).toEqual('Error: something')
            })

            it('leaves an object entry in the database', async () => {
                const pluginConfig = (await getPluginConfigRows(server))[0]

                const console = createConsole(server, pluginConfig)

                await ((console[method]({ 1: 'ein', 2: 'zwei' }) as unknown) as Promise<void>)

                const pluginLogEntries = await server.db.fetchPluginLogEntries()

                expect(pluginLogEntries.length).toBe(1)
                expect(pluginLogEntries[0].type).toEqual(type)
                expect(pluginLogEntries[0].message).toEqual(code`
                    {
                        "1": "ein",
                        "2": "zwei"
                    }`)
            })
        })
    })
})
