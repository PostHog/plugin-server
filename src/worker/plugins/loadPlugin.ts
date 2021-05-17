import * as fs from 'fs'
import * as path from 'path'

import { PluginConfig, PluginJsonConfig, PluginsServer } from '../../types'
import { processError } from '../../utils/db/error'
import { setPluginCapabilities } from '../../utils/db/sql'
import { getFileFromArchive, pluginDigest } from '../../utils/utils'

export async function loadPlugin(server: PluginsServer, pluginConfig: PluginConfig): Promise<boolean> {
    const { plugin } = pluginConfig

    if (!plugin) {
        pluginConfig.vm?.failInitialization!()
        return false
    }

    try {
        if (plugin.url?.startsWith('file:')) {
            const pluginPath = path.resolve(server.BASE_DIR, plugin.url.substring(5))
            const configPath = path.resolve(pluginPath, 'plugin.json')

            let config: PluginJsonConfig = {}
            if (fs.existsSync(configPath)) {
                try {
                    const jsonBuffer = fs.readFileSync(configPath)
                    config = JSON.parse(jsonBuffer.toString())
                } catch (e) {
                    pluginConfig.vm?.failInitialization!()
                    await processError(
                        server,
                        pluginConfig,
                        `Could not load posthog config at "${configPath}" for ${pluginDigest(plugin)}`
                    )
                    return false
                }
            }

            if (!config['main'] && !fs.existsSync(path.resolve(pluginPath, 'index.js'))) {
                pluginConfig.vm?.failInitialization!()
                await processError(
                    server,
                    pluginConfig,
                    `No "main" config key or "index.js" file found for ${pluginDigest(plugin)}`
                )
                return false
            }

            const jsPath = path.resolve(pluginPath, config['main'] || 'index.js')
            const indexJs = fs.readFileSync(jsPath).toString()

            void pluginConfig.vm?.initialize!(
                server,
                pluginConfig,
                indexJs,
                `local ${pluginDigest(plugin)} from "${pluginPath}"!`
            )
            await inferPluginCapabilities(server, pluginConfig)
            return true
        } else if (plugin.archive) {
            let config: PluginJsonConfig = {}
            const archive = Buffer.from(plugin.archive)
            const json = await getFileFromArchive(archive, 'plugin.json')
            if (json) {
                try {
                    config = JSON.parse(json)
                } catch (error) {
                    pluginConfig.vm?.failInitialization!()
                    await processError(server, pluginConfig, `Can not load plugin.json for ${pluginDigest(plugin)}`)
                    return false
                }
            }

            const indexJs = await getFileFromArchive(archive, config['main'] || 'index.js')

            if (indexJs) {
                void pluginConfig.vm?.initialize!(server, pluginConfig, indexJs, pluginDigest(plugin))
                await inferPluginCapabilities(server, pluginConfig)
                return true
            } else {
                pluginConfig.vm?.failInitialization!()
                await processError(server, pluginConfig, `Could not load index.js for ${pluginDigest(plugin)}!`)
            }
        } else if (plugin.plugin_type === 'source' && plugin.source) {
            void pluginConfig.vm?.initialize!(server, pluginConfig, plugin.source, pluginDigest(plugin))
            await inferPluginCapabilities(server, pluginConfig)
            return true
        } else {
            pluginConfig.vm?.failInitialization!()
            await processError(
                server,
                pluginConfig,
                `Tried using undownloaded remote ${pluginDigest(plugin)}, which is not supported!`
            )
        }
    } catch (error) {
        pluginConfig.vm?.failInitialization!()
        await processError(server, pluginConfig, error)
    }
    return false
}

async function inferPluginCapabilities(server: PluginsServer, pluginConfig: PluginConfig) {
    // infer on load implies there's no lazy loading, but all workers get
    // these properties loaded
    const vm = await pluginConfig.vm?.resolveInternalVm
    const capabilities: string[] = []

    const tasks = vm?.tasks
    const methods = vm?.methods

    if (methods) {
        for (const [key, value] of Object.entries(methods)) {
            if (value !== undefined) {
                capabilities.push(key)
            }
        }
    }

    if (tasks?.schedule) {
        for (const [key, value] of Object.entries(tasks.schedule)) {
            if (value) {
                capabilities.push(key)
            }
        }
    }

    // TODO: this probably shouldn't be here, and a catch-all "jobs" capability
    // instead
    if (tasks?.job) {
        for (const [key, value] of Object.entries(tasks.job)) {
            if (value) {
                capabilities.push(key)
            }
        }
    }

    await setPluginCapabilities(server, pluginConfig, capabilities)
}
