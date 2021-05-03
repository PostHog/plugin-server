import { randomBytes } from 'crypto'
import { VM } from 'vm2'

import { PluginConfig, PluginConfigVMReponse, PluginsServer } from '../../types'
import { createCache } from './extensions/cache'
import { createConsole } from './extensions/console'
import { createGeoIp } from './extensions/geoip'
import { createGoogle } from './extensions/google'
import { createJobs } from './extensions/jobs'
import { createPosthog } from './extensions/posthog'
import { createStorage } from './extensions/storage'
import { imports } from './imports'
import { transformCode } from './transforms'

export async function createPluginConfigVM(
    server: PluginsServer,
    pluginConfig: PluginConfig, // NB! might have team_id = 0
    indexJs: string
): Promise<PluginConfigVMReponse> {
    const transformedCode = transformCode(indexJs, server, imports)

    // Create virtual machine
    const vm = new VM({
        timeout: server.TASK_TIMEOUT * 1000 + 1,
        sandbox: {},
    })

    // Add PostHog utilities to virtual machine
    vm.freeze(createConsole(server, pluginConfig), 'console')
    vm.freeze(createPosthog(server, pluginConfig), 'posthog')

    // Add non-PostHog utilities to virtual machine
    vm.freeze(imports['node-fetch'], 'fetch')
    vm.freeze(createGoogle(), 'google')

    vm.freeze(imports, '__pluginHostImports')

    if (process.env.NODE_ENV === 'test') {
        vm.freeze(setTimeout, '__jestSetTimeout')
    }

    // Creating this outside the vm (so not in a babel plugin for example)
    // because `setTimeout` is not available inside the vm... and we don't want to
    // make it available for now, as it makes it easier to create malicious code
    const asyncGuard = async (promise: () => Promise<any>) => {
        const timeout = server.TASK_TIMEOUT
        return await Promise.race([
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
    }

    vm.freeze(asyncGuard, '__asyncGuard')

    vm.freeze(
        {
            cache: createCache(server, pluginConfig.plugin_id, pluginConfig.team_id),
            config: pluginConfig.config,
            attachments: pluginConfig.attachments,
            storage: createStorage(server, pluginConfig),
            geoip: createGeoIp(server),
            jobs: createJobs(server, pluginConfig),
        },
        '__pluginHostMeta'
    )

    vm.run(`
        // two ways packages could export themselves (plus "global")
        const module = { exports: {} };
        let exports = {};

        // the plugin JS code
        ${transformedCode};
    `)

    const responseVar = `__pluginDetails${randomBytes(64).toString('hex')}`

    // Explicitly passing __asyncGuard to the returned function from `vm.run` in order
    // to make it harder to override the global `__asyncGuard = noop` inside plugins.
    // This way even if promises inside plugins are unbounded, the `processEvent` function
    // itself will still terminate after TASK_TIMEOUT seconds, not clogging the entire ingestion.
    vm.run(`
        if (typeof global.${responseVar} !== 'undefined') {
            throw new Error("Plugin created variable ${responseVar} that is reserved for the VM.")
        }
        let ${responseVar} = undefined;
        ((__asyncGuard) => {
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
                setupPlugin: __asyncFunctionGuard(__bindMeta('setupPlugin')),
                teardownPlugin: __asyncFunctionGuard(__bindMeta('teardownPlugin')),
                processEvent: __asyncFunctionGuard(__bindMeta('processEvent')),
                processEventBatch: __asyncFunctionGuard(__bindMeta('processEventBatch')),
            };

            const __tasks = {
                schedule: {},
                job: {},
            };

            for (const exportDestination of __getExportDestinations().reverse()) {
                // gather the runEveryX commands and export in __tasks
                for (const [name, value] of Object.entries(exportDestination)) {
                    if (name.startsWith("runEvery") && typeof value === 'function') {
                        __tasks.schedule[name] = {
                            name: name,
                            type: 'schedule',
                            exec: __bindMeta(value)
                        }
                    }
                }

                // gather all jobs
                if (typeof exportDestination['jobs'] === 'object') {
                    for (const [key, value] of Object.entries(exportDestination['jobs'])) {
                        __tasks.job[key] = {
                            name: key,
                            type: 'job',
                            exec: __bindMeta(value)
                        }
                    }
                }
            }

            ${responseVar} = { __methods, __tasks, }
        })
    `)(asyncGuard)

    await vm.run(`${responseVar}.__methods.setupPlugin?.()`)

    return {
        vm,
        methods: vm.run(`${responseVar}.__methods`),
        tasks: vm.run(`${responseVar}.__tasks`),
    }
}
