import * as fs from 'fs'
import * as path from 'path'

import { clearError, processError } from '../error'
import { PluginConfig, PluginJsonConfig, PluginsServer } from '../types'
import { getFileFromArchive } from '../utils'
import { createLazyPluginVM } from '../vm/lazy'

export async function loadPlugin(server: PluginsServer, pluginConfig: PluginConfig): Promise<boolean> {
    const { plugin } = pluginConfig

    if (!plugin) {
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
                    await processError(
                        server,
                        pluginConfig,
                        `Could not load posthog config at "${configPath}" for plugin "${plugin.name}"`
                    )
                    return false
                }
            }

            if (!config['main'] && !fs.existsSync(path.resolve(pluginPath, 'index.js'))) {
                await processError(
                    server,
                    pluginConfig,
                    `No "main" config key or "index.js" file found for plugin "${plugin.name}"`
                )
                return false
            }

            const jsPath = path.resolve(pluginPath, config['main'] || 'index.js')
            const indexJs = fs.readFileSync(jsPath).toString()

            const libPath = path.resolve(pluginPath, config['lib'] || 'lib.js')
            const libJs = fs.existsSync(libPath) ? fs.readFileSync(libPath).toString() : ''
            if (libJs) {
                console.warn(`⚠️ Using "lib.js" is deprecated! Used by: ${plugin.name} (${plugin.url})`)
            }

            pluginConfig.vm = createLazyPluginVM(
                server,
                pluginConfig,
                indexJs,
                libJs,
                `local plugin "${plugin.name}" from "${pluginPath}"!`
            )
            return true
        } else if (plugin.archive) {
            let config: PluginJsonConfig = {}
            const archive = Buffer.from(plugin.archive)
            const json = await getFileFromArchive(archive, 'plugin.json')
            if (json) {
                try {
                    config = JSON.parse(json)
                } catch (error) {
                    await processError(server, pluginConfig, `Can not load plugin.json for plugin "${plugin.name}"`)
                    return false
                }
            }

            const indexJs = await getFileFromArchive(archive, config['main'] || 'index.js')
            const libJs = await getFileFromArchive(archive, config['lib'] || 'lib.js')
            if (libJs) {
                console.warn(`⚠️ Using "lib.js" is deprecated! Used by: ${plugin.name} (${plugin.url})`)
            }

            if (indexJs) {
                pluginConfig.vm = createLazyPluginVM(
                    server,
                    pluginConfig,
                    indexJs,
                    libJs || '',
                    `plugin "${plugin.name}"!`
                )
                return true
            } else {
                await processError(server, pluginConfig, `Could not load index.js for plugin "${plugin.name}"!`)
            }
        } else if (plugin.plugin_type === 'source' && plugin.source) {
            pluginConfig.vm = createLazyPluginVM(server, pluginConfig, plugin.source, '', `plugin "${plugin.name}"!`)
            return true
        } else {
            await processError(
                server,
                pluginConfig,
                `Un-downloaded remote plugins not supported! Plugin: "${plugin.name}"`
            )
        }
    } catch (error) {
        await processError(server, pluginConfig, error)
    }
    return false
}
