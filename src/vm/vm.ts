import { transform } from '@babel/standalone'
import { randomBytes } from 'crypto'
import fetch from 'node-fetch'
import { VM } from 'vm2'

import { PluginConfig, PluginConfigVMReponse, PluginsServer } from '../types'
import { createCache } from './extensions/cache'
import { createConsole } from './extensions/console'
import { createGoogle } from './extensions/google'
import { createPosthog } from './extensions/posthog'
import { createStorage } from './extensions/storage'
import { loopTimeout } from './transforms/loop-timeout'
import { promiseTimeout } from './transforms/promise-timeout'

export async function createPluginConfigVM(
    server: PluginsServer,
    pluginConfig: PluginConfig, // NB! might have team_id = 0
    indexJs: string,
    libJs = ''
): Promise<PluginConfigVMReponse> {
    const source = libJs ? `${libJs};${indexJs}` : indexJs
    const { code } = transform(source, {
        envName: 'production',
        filename: undefined,
        cwd: undefined,
        code: true,
        ast: false,
        sourceMaps: false,
        babelrc: false,
        configFile: false,
        presets: [['env', { targets: { node: process.versions.node } }]],
        plugins: [loopTimeout(server), promiseTimeout(server)],
    })

    // create virtual machine
    const vm = new VM({
        timeout: server.TASK_TIMEOUT * 1000 + 1,
        sandbox: {},
    })

    // our own stuff
    vm.freeze(createConsole(), 'console')
    vm.freeze(createPosthog(server, pluginConfig), 'posthog')

    // exported node packages
    vm.freeze(fetch, 'fetch')
    vm.freeze(createGoogle(), 'google')

    if (process.env.NODE_ENV === 'test') {
        vm.freeze(setTimeout, '__jestSetTimeout')
    }

    vm.freeze(async (promise: () => Promise<any>) => {
        const timeout = server.TASK_TIMEOUT
        const response = await Promise.race([
            promise,
            new Promise((resolve, reject) =>
                setTimeout(() => {
                    const message = `Script execution timed out after promise waited for ${timeout} second${
                        timeout === 1 ? '' : 's'
                    }`
                    reject(new Error(message))
                }, timeout * 1000)
            ),
        ])
        return response
    }, '__asyncGuard')

    vm.freeze(
        {
            cache: createCache(
                server,
                pluginConfig.plugin?.name || pluginConfig.plugin_id.toString(),
                pluginConfig.team_id
            ),
            config: pluginConfig.config,
            attachments: pluginConfig.attachments,
            storage: createStorage(server, pluginConfig),
        },
        '__pluginHostMeta'
    )

    vm.run(`
        // two ways packages could export themselves (plus "global")
        const module = { exports: {} };
        let exports = {};

        // the plugin JS code
        ${code};
    `)

    const responseVar = `__pluginDetails${randomBytes(64).toString('hex')}`

    vm.run(`
        const ${responseVar} = (() => {
            // helpers to get globals
            const __getExportDestinations = () => [exports, module.exports, global]
            const __getExported = (key) => __getExportDestinations().find(a => a[key])?.[key];
            const __asyncFunctionGuard = (func) => func ? (...args) => __asyncGuard(func(...args)) : func

            // inject the meta object + shareable 'global' to the end of each exported function
            const __pluginMeta = {
                ...__pluginHostMeta,
                global: {}
            };
            function __bindMeta (keyOrFunc) {
                const func = typeof keyOrFunc === 'function' ? keyOrFunc : __getExported(keyOrFunc);
                if (func) return (...args) => func(...args, __pluginMeta);
            }
            function __callWithMeta (keyOrFunc, ...args) {
                const func = __bindMeta(keyOrFunc);
                if (func) return func(...args);
            }

            // we have processEvent, but not processEventBatch
            if (!__getExported('processEventBatch') && __getExported('processEvent')) {
                exports.processEventBatch = async function processEventBatch (batch, meta) {
                    const processEvent = __getExported('processEvent');
                    let waitFor = false
                    const processedEvents = batch.map(event => {
                        const e = processEvent(event, meta)
                        if (e && typeof e.then !== 'undefined') {
                            waitFor = true
                        }
                        return e
                    })
                    const response = waitFor ? (await Promise.all(processedEvents)) : processedEvents;
                    return response.filter(r => r)
                }
            // we have processEventBatch, but not processEvent
            } else if (!__getExported('processEvent') && __getExported('processEventBatch')) {
                exports.processEvent = async function processEvent (event, meta) {
                    return (await (__getExported('processEventBatch'))([event], meta))?.[0]
                }
            }

            // export various functions
            const __methods = {
                processEvent: __asyncFunctionGuard(__bindMeta('processEvent')),
                processEventBatch: __asyncFunctionGuard(__bindMeta('processEventBatch'))
            };

            // gather the runEveryX commands and export in __tasks
            const __tasks = {};
            for (const exportDestination of __getExportDestinations().reverse()) {
                for (const [name, value] of Object.entries(exportDestination)) {
                    if (name.startsWith("runEvery") && typeof value === 'function') {
                        __tasks[name] = {
                            name: name,
                            type: 'runEvery',
                            exec: __bindMeta(value)
                        }
                    }
                }
            }

            // run the plugin setup script, if present
            const __setupPlugin = __asyncFunctionGuard(async () => __callWithMeta('setupPlugin'));

            return {
                __methods,
                __tasks,
                __setupPlugin
            }
        })();
    `)

    await vm.run(`${responseVar}.__setupPlugin()`)

    return {
        vm,
        methods: vm.run(`${responseVar}.__methods`),
        tasks: vm.run(`${responseVar}.__tasks`),
    }
}
