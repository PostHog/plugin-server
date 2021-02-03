import * as path from 'path'
import * as fs from 'fs'
import { createPluginConfigVM } from './vm'
import { PluginsServer, PluginConfig, PluginJsonConfig, TeamId, PluginTask } from './types'
import { PluginEvent, PluginAttachment } from '@posthog/plugin-scaffold'
import { clearError, processError } from './error'
import { getFileFromArchive } from './utils'
import { getPluginAttachmentRows, getPluginConfigRows, getPluginRows } from './sql'
import { status } from './status'

export async function setupPlugins(server: PluginsServer): Promise<void> {
    const pluginRows = await getPluginRows(server)
    const foundPlugins = new Map<number, boolean>()
    for (const row of pluginRows) {
        foundPlugins.set(row.id, true)
        server.plugins.set(row.id, row)
    }
    for (const [id, plugin] of server.plugins) {
        if (!foundPlugins.has(id)) {
            server.plugins.delete(id)
        }
    }

    const pluginAttachmentRows = await getPluginAttachmentRows(server)
    const attachmentsPerConfig = new Map<TeamId, Record<string, PluginAttachment>>()
    for (const row of pluginAttachmentRows) {
        let attachments = attachmentsPerConfig.get(row.plugin_config_id)
        if (!attachments) {
            attachments = {}
            attachmentsPerConfig.set(row.plugin_config_id, attachments)
        }
        attachments[row.key] = {
            content_type: row.content_type,
            file_name: row.file_name,
            contents: row.contents,
        }
    }

    const pluginConfigRows = await getPluginConfigRows(server)
    const foundPluginConfigs = new Map<number, boolean>()
    server.pluginConfigsPerTeam.clear()
    server.defaultConfigs = []
    for (const row of pluginConfigRows) {
        const plugin = server.plugins.get(row.plugin_id)
        if (!plugin) {
            continue
        }
        foundPluginConfigs.set(row.id, true)
        const pluginConfig: PluginConfig = {
            ...row,
            plugin: plugin,
            attachments: attachmentsPerConfig.get(row.id) || {},
            vm: null,
        }
        server.pluginConfigs.set(row.id, pluginConfig)

        if (!row.team_id) {
            server.defaultConfigs.push(row)
        } else {
            let teamConfigs = server.pluginConfigsPerTeam.get(row.team_id)
            if (!teamConfigs) {
                teamConfigs = []
                server.pluginConfigsPerTeam.set(row.team_id, teamConfigs)
            }
            teamConfigs.push(pluginConfig)
        }
    }
    for (const [id, pluginConfig] of server.pluginConfigs) {
        if (!foundPluginConfigs.has(id)) {
            server.pluginConfigs.delete(id)
        } else if (!pluginConfig.vm) {
            await loadPlugin(server, pluginConfig)
        }
    }

    // gather runEvery* tasks into a schedule
    server.pluginSchedule = { runEveryMinute: [], runEveryHour: [], runEveryDay: [] }
    for (const [id, pluginConfig] of server.pluginConfigs) {
        for (const [taskName, task] of Object.entries(pluginConfig.vm?.tasks ?? {})) {
            if (task && taskName in server.pluginSchedule) {
                server.pluginSchedule[taskName].push(pluginConfig.id)
            }
        }
    }

    const sortFunction = (a: PluginConfig, b: PluginConfig) => a.order - b.order
    for (const teamId of server.pluginConfigsPerTeam.keys()) {
        if (server.defaultConfigs.length > 0) {
            const combinedPluginConfigs = [
                ...(server.pluginConfigsPerTeam.get(teamId) || []),
                ...server.defaultConfigs,
            ].sort(sortFunction)
            server.pluginConfigsPerTeam.set(teamId, combinedPluginConfigs)
        } else {
            server.pluginConfigsPerTeam.get(teamId)?.sort(sortFunction)
        }
    }
}

async function loadPlugin(server: PluginsServer, pluginConfig: PluginConfig): Promise<boolean> {
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

            try {
                pluginConfig.vm = await createPluginConfigVM(server, pluginConfig, indexJs, libJs)
                status.info('🔌', `Loaded local plugin "${plugin.name}" from "${pluginPath}"!`)
                await clearError(server, pluginConfig)
                return true
            } catch (error) {
                await processError(server, pluginConfig, error)
            }
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
                try {
                    pluginConfig.vm = await createPluginConfigVM(server, pluginConfig, indexJs, libJs || '')
                    status.info('🔌', `Loaded plugin "${plugin.name}"!`)
                    await clearError(server, pluginConfig)
                    return true
                } catch (error) {
                    await processError(server, pluginConfig, error)
                }
            } else {
                await processError(server, pluginConfig, `Could not load index.js for plugin "${plugin.name}"!`)
            }
        } else if (plugin.plugin_type === 'source' && plugin.source) {
            try {
                pluginConfig.vm = await createPluginConfigVM(server, pluginConfig, plugin.source)
                status.info('🔌', `Loaded plugin "${plugin.name}"!`)
                await clearError(server, pluginConfig)
                return true
            } catch (error) {
                await processError(server, pluginConfig, error)
            }
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

export async function runPlugins(server: PluginsServer, event: PluginEvent): Promise<PluginEvent | null> {
    const pluginsToRun = getPluginsForTeam(server, event.team_id)
    let returnedEvent: PluginEvent | null = event

    for (const pluginConfig of pluginsToRun.reverse()) {
        if (pluginConfig.vm?.methods?.processEvent) {
            const timer = new Date()

            const { processEvent } = pluginConfig.vm.methods
            try {
                returnedEvent = (await processEvent(returnedEvent)) || null
            } catch (error) {
                await processError(server, pluginConfig, error, returnedEvent)
                server.statsd?.increment(`plugin.${pluginConfig.plugin?.name}.process_event.ERROR`)
            }
            server.statsd?.timing(`plugin.${pluginConfig.plugin?.name}.process_event`, timer)

            if (!returnedEvent) {
                return null
            }
        }
    }

    return returnedEvent
}

export async function runPluginsOnBatch(server: PluginsServer, batch: PluginEvent[]): Promise<PluginEvent[]> {
    const eventsByTeam = new Map<number, PluginEvent[]>()

    for (const event of batch) {
        if (eventsByTeam.has(event.team_id)) {
            eventsByTeam.get(event.team_id)!.push(event)
        } else {
            eventsByTeam.set(event.team_id, [event])
        }
    }

    let allReturnedEvents: PluginEvent[] = []

    for (const [teamId, teamEvents] of eventsByTeam.entries()) {
        const pluginsToRun = getPluginsForTeam(server, teamId)

        let returnedEvents: PluginEvent[] = teamEvents

        for (const pluginConfig of pluginsToRun.reverse()) {
            const timer = new Date()
            const { processEventBatch } = pluginConfig.vm?.methods || {}
            if (processEventBatch && returnedEvents.length > 0) {
                try {
                    returnedEvents = (await processEventBatch(returnedEvents)) || []
                } catch (error) {
                    await processError(server, pluginConfig, error, returnedEvents[0])
                    server.statsd?.increment(`plugin.${pluginConfig.plugin?.name}.process_event_batch.ERROR`)
                }
                server.statsd?.timing(`plugin.${pluginConfig.plugin?.name}.process_event_batch`, timer)
            }
        }

        allReturnedEvents = allReturnedEvents.concat(returnedEvents)
    }

    return allReturnedEvents.filter(Boolean)
}

export async function runPluginTask(server: PluginsServer, taskName: string, pluginConfigId: number): Promise<any> {
    const timer = new Date()
    let response
    try {
        const pluginConfig = server.pluginConfigs.get(pluginConfigId)
        const task = pluginConfig?.vm?.tasks[taskName]
        response = await task?.exec()
    } catch (error) {
        await processError(server, pluginConfigId, error)
        server.statsd?.increment(`plugin.task.${taskName}.${pluginConfigId}.ERROR`)
    }
    server.statsd?.timing(`plugin.task.${taskName}.${pluginConfigId}`, timer)
    return response
}

function getPluginsForTeam(server: PluginsServer, teamId: number): PluginConfig[] {
    return server.pluginConfigsPerTeam.get(teamId) || server.defaultConfigs
}
