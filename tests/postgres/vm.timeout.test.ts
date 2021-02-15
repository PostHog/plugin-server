import { createServer } from '../../src/server'
import { PluginsServer } from '../../src/types'
import { createPluginConfigVM } from '../../src/vm/vm'
import { pluginConfig39 } from '../helpers/plugins'
import { resetTestDatabase } from '../helpers/sql'

const defaultEvent = {
    distinct_id: 'my_id',
    ip: '127.0.0.1',
    site_url: 'http://localhost',
    team_id: 3,
    now: new Date().toISOString(),
    event: 'default event',
    properties: {},
}

describe('vm timeout tests', () => {
    let server: PluginsServer
    let stopServer: () => Promise<void>

    beforeEach(async () => {
        ;[server, stopServer] = await createServer({
            TASK_TIMEOUT: 1,
        })
    })

    afterEach(async () => {
        await stopServer()
    })

    test('while loop', async () => {
        const indexJs = `
            async function processEvent (event, meta) {
                while(1) {}
                event.properties.processed = 'yup'
                return event
            }
        `
        await resetTestDatabase(indexJs)
        const vm = await createPluginConfigVM(server, pluginConfig39, indexJs)
        const date = new Date()
        let errorMessage = undefined
        try {
            await vm.methods.processEvent({ ...defaultEvent })
        } catch (e) {
            errorMessage = e.message
        }
        expect(new Date().valueOf() - date.valueOf()).toBeGreaterThan(1000)
        expect(errorMessage!).toEqual('1 second loop timeout on line 3')
    })

    test('while loop no body', async () => {
        const indexJs = `
            async function processEvent (event, meta) {
                let i = 0
                while(1) i++;
                event.properties.processed = 'yup'
                return event
            }
        `
        await resetTestDatabase(indexJs)
        const vm = await createPluginConfigVM(server, pluginConfig39, indexJs)
        let errorMessage = undefined
        try {
            await vm.methods.processEvent({ ...defaultEvent })
        } catch (e) {
            errorMessage = e.message
        }
        expect(errorMessage!).toEqual('1 second loop timeout on line 4')
    })

    test('while loop in promise', async () => {
        const indexJs = `
            async function processEvent (event, meta) {
                await Promise.resolve().then(() => { while(1) {}; })
                event.properties.processed = 'yup'
                return event
            }
        `
        await resetTestDatabase(indexJs)
        const vm = await createPluginConfigVM(server, pluginConfig39, indexJs)
        let errorMessage = undefined
        try {
            await vm.methods.processEvent({ ...defaultEvent })
        } catch (e) {
            errorMessage = e.message
        }
        expect(errorMessage!).toEqual('1 second loop timeout on line 3')
    })

    test('do..while loop', async () => {
        const indexJs = `
            async function processEvent (event, meta) {
                do {} while (true);
                event.properties.processed = 'yup'
                return event
            }
        `
        await resetTestDatabase(indexJs)
        const vm = await createPluginConfigVM(server, pluginConfig39, indexJs)
        let errorMessage = undefined
        try {
            await vm.methods.processEvent({ ...defaultEvent })
        } catch (e) {
            errorMessage = e.message
        }
        expect(errorMessage!).toEqual('1 second loop timeout on line 3')
    })

    test('do..while loop no body', async () => {
        const indexJs = `
            async function processEvent (event, meta) {
                let i = 0;
                do i++; while (true);
                event.properties.processed = 'yup'
                return event
            }
        `
        await resetTestDatabase(indexJs)
        const vm = await createPluginConfigVM(server, pluginConfig39, indexJs)
        let errorMessage = undefined
        try {
            await vm.methods.processEvent({ ...defaultEvent })
        } catch (e) {
            errorMessage = e.message
        }
        expect(errorMessage!).toEqual('1 second loop timeout on line 4')
    })

    test('do..while loop in promise', async () => {
        const indexJs = `
            async function processEvent (event, meta) {
                await Promise.resolve().then(() => { do {} while (true); })
                event.properties.processed = 'yup'
                return event
            }
        `
        await resetTestDatabase(indexJs)
        const vm = await createPluginConfigVM(server, pluginConfig39, indexJs)
        let errorMessage = undefined
        try {
            await vm.methods.processEvent({ ...defaultEvent })
        } catch (e) {
            errorMessage = e.message
        }
        expect(errorMessage!).toEqual('1 second loop timeout on line 3')
    })

    test('for loop', async () => {
        const indexJs = `
            async function processEvent (event, meta) {
                for(let i = 0; i < 1; i--) {}
                event.properties.processed = 'yup'
                return event
            }
        `
        await resetTestDatabase(indexJs)
        const vm = await createPluginConfigVM(server, pluginConfig39, indexJs)
        let errorMessage = undefined
        try {
            await vm.methods.processEvent({ ...defaultEvent })
        } catch (e) {
            errorMessage = e.message
        }
        expect(errorMessage!).toEqual('1 second loop timeout on line 3')
    })

    test('for loop no body', async () => {
        const indexJs = `
            async function processEvent (event, meta) {
                let a = 0
                for(let i = 0; i < 1; i--) a++
                event.properties.processed = 'yup'
                return event
            }
        `
        await resetTestDatabase(indexJs)
        const vm = await createPluginConfigVM(server, pluginConfig39, indexJs)
        let errorMessage = undefined
        try {
            await vm.methods.processEvent({ ...defaultEvent })
        } catch (e) {
            errorMessage = e.message
        }
        expect(errorMessage!).toEqual('1 second loop timeout on line 4')
    })

    test('for loop in promise', async () => {
        const indexJs = `
            async function processEvent (event, meta) {
                await Promise.resolve().then(() => { for(let i = 0; i < 1; i--) {}; })
                event.properties.processed = 'yup'
                return event
            }
        `
        await resetTestDatabase(indexJs)
        const vm = await createPluginConfigVM(server, pluginConfig39, indexJs)
        let errorMessage = undefined
        try {
            await vm.methods.processEvent({ ...defaultEvent })
        } catch (e) {
            errorMessage = e.message
        }
        expect(errorMessage!).toEqual('1 second loop timeout on line 3')
    })

    test.skip('long promise', async () => {
        const indexJs = `
            async function processEvent (event, meta) {
                await new Promise(resolve => __jestSetTimeout(() => resolve(), 40000))
                event.properties.processed = 'yup'
                return event
            }
        `
        await resetTestDatabase(indexJs)
        const vm = await createPluginConfigVM(server, pluginConfig39, indexJs)
        let errorMessage = undefined
        try {
            await vm.methods.processEvent({ ...defaultEvent })
        } catch (e) {
            errorMessage = e.message
        }
        expect(errorMessage!).toEqual('Long Promise Timeout')
    })
})
