import { VM } from 'vm2'
import fetch from 'node-fetch'
import { createConsole } from './extensions/console'
import { PluginsServer, PluginConfig, PluginConfigVMReponse } from './types'
import { PluginEvent } from 'posthog-plugins'
import { createCache } from './extensions/cache'
import { createInternalPostHogInstance } from 'posthog-js-lite'
import { performance } from 'perf_hooks'

function areWeTestingWithJest() {
    return process.env.JEST_WORKER_ID !== undefined
}

export function createPluginConfigVM(
    server: PluginsServer,
    pluginConfig: PluginConfig, // NB! might have team_id = 0
    indexJs: string,
    libJs = ''
): PluginConfigVMReponse {
    const vm = new VM({
        sandbox: {},
    })
    vm.freeze(createConsole(), 'console')
    vm.freeze(fetch, 'fetch')
    if (areWeTestingWithJest()) {
        vm.freeze(setTimeout, '__jestSetTimeout')
    }
    vm.freeze(
        {
            cache: createCache(
                server,
                pluginConfig.plugin?.name || pluginConfig.plugin_id.toString(),
                pluginConfig.team_id
            ),
            config: pluginConfig.config,
            attachments: pluginConfig.attachments,
        },
        '__pluginHostMeta'
    )
    vm.run(
        `
        // two ways packages could export themselves (plus "global")
        const module = { exports: {} };
        let exports = {};
        const __getExported = (key) => exports[key] || module.exports[key] || global[key]; 
        
        // the plugin JS code        
        ${libJs};
        ${indexJs};

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
        
        // run the plugin setup script, if present
        __callWithMeta('setupPlugin');
        
        // we have processEvent, but not processEvents
        if (!__getExported('processEvents') && __getExported('processEvent')) {
            exports.processEvents = async function processEvents (events, meta) {
                const processEvent = __getExported('processEvent');
                const pArray = events.map(async event => await processEvent(event, meta))
                const response = await Promise.all(pArray);
                return response.filter(r => r)
            }
        // we have processEvents, but not processEvent
        } else if (!__getExported('processEvent') && __getExported('processEvents')) {
            exports.processEvent = async function processEvent (event, meta) {
                return (await (__getExported('processEvents'))([event], meta))?.[0]
            }
        }
        
        // export various functions
        const __methods = {
            processEvent: __bindMeta('processEvent'),
            processEvents: __bindMeta('processEvents')
        };
        `
    )

    return {
        vm,
        methods: vm.run('__methods'),
    }
}

export function prepareForRun(
    server: PluginsServer,
    teamId: number,
    pluginConfig: PluginConfig, // might have team_id=0
    method: 'processEvent' | 'processEvents',
    event?: PluginEvent
):
    | null
    | ((event: PluginEvent) => Promise<PluginEvent>)
    | ((events: PluginEvent[]) => Promise<PluginEvent[]>)
    | (() => Promise<void>) {
    if (!pluginConfig.vm?.methods[method]) {
        return null
    }

    const { vm } = pluginConfig.vm

    if (event?.properties?.token) {
        // TODO: this should be nicer... and it's not optimised for batch processing!
        // We should further split the batches per site_url and token!
        const posthog = createInternalPostHogInstance(
            event.properties.token,
            { apiHost: event.site_url, fetch },
            {
                performance: performance,
            }
        )
        vm.freeze(posthog, 'posthog')
    } else {
        vm.freeze(null, 'posthog')
    }

    return pluginConfig.vm.methods[method]
}
