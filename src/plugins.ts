import { PluginAttachment, PluginEvent } from '@posthog/plugin-scaffold'
import * as fs from 'fs'
import * as path from 'path'

import { clearError, processError } from './error'
import { getPluginAttachmentRows, getPluginConfigRows, getPluginRows } from './sql'
import { status } from './status'
import { Plugin, PluginConfig, PluginConfigId, PluginId, PluginJsonConfig, PluginsServer, TeamId } from './types'
import { getFileFromArchive } from './utils'
import { createLazyPluginVM } from './vm/lazy'

export async function setupPlugins(server: PluginsServer): Promise<void> {
    const { plugins, pluginConfigs, pluginConfigsPerTeam } = await loadPluginsFromDB(server)

    for (const [id, pluginConfig] of pluginConfigs) {
        const plugin = plugins.get(pluginConfig.plugin_id)
        const prevConfig = server.pluginConfigs.get(id)
        const prevPlugin = prevConfig ? server.plugins.get(pluginConfig.plugin_id) : null

        // :TRICKY: This forces a reload for plugin VMs which have either been added or changedW
        if (
            prevConfig &&
            pluginConfig.updated_at === prevConfig.updated_at &&
            plugin?.updated_at == prevPlugin?.updated_at
        ) {
            pluginConfig.vm = prevConfig.vm
        }

        if (!pluginConfig.vm) {
            await loadPlugin(server, pluginConfig)
        }
    }

    server.plugins = plugins
    server.pluginConfigs = pluginConfigs
    server.pluginConfigsPerTeam = pluginConfigsPerTeam

    for (const teamId of server.pluginConfigsPerTeam.keys()) {
        server.pluginConfigsPerTeam.get(teamId)?.sort((a, b) => a.order - b.order)
    }

    void loadSchedule(server)
}

export async function loadPluginsFromDB(
    server: PluginsServer
): Promise<Pick<PluginsServer, 'plugins' | 'pluginConfigs' | 'pluginConfigsPerTeam'>> {
    const pluginRows = await getPluginRows(server)
    const plugins = new Map<PluginId, Plugin>()

    for (const row of pluginRows) {
        plugins.set(row.id, row)
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

    const pluginConfigs = new Map<PluginConfigId, PluginConfig>()
    const pluginConfigsPerTeam = new Map<TeamId, PluginConfig[]>()

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
        pluginConfigs.set(row.id, pluginConfig)

        if (!row.team_id) {
            console.error(`🔴 PluginConfig(id=${row.id}) without team_id!`)
            continue
        }

        let teamConfigs = pluginConfigsPerTeam.get(row.team_id)
        if (!teamConfigs) {
            teamConfigs = []
            pluginConfigsPerTeam.set(row.team_id, teamConfigs)
        }
        teamConfigs.push(pluginConfig)
    }

    return { plugins, pluginConfigs, pluginConfigsPerTeam }
}

export async function loadSchedule(server: PluginsServer): Promise<void> {
    server.pluginSchedule = null

    // gather runEvery* tasks into a schedule
    const pluginSchedule: Record<string, PluginConfigId[]> = { runEveryMinute: [], runEveryHour: [], runEveryDay: [] }

    for (const [id, pluginConfig] of server.pluginConfigs) {
        const tasks = (await pluginConfig.vm?.getTasks()) ?? {}
        for (const [taskName, task] of Object.entries(tasks)) {
            if (task && taskName in pluginSchedule) {
                pluginSchedule[taskName].push(id)
            }
        }
    }

    status.info('🔌', 'Finished loading plugin scheduled tasks')

    server.pluginSchedule = pluginSchedule
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

            pluginConfig.vm = createLazyPluginVM(
                server,
                pluginConfig,
                indexJs,
                libJs,
                `local plugin "${plugin.name}" from "${pluginPath}"!`
            )
            await clearError(server, pluginConfig) // :TODO: Only clear after successful setup.
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
                    `Loaded plugin "${plugin.name}"!`
                )
                await clearError(server, pluginConfig)
                return true
            } else {
                await processError(server, pluginConfig, `Could not load index.js for plugin "${plugin.name}"!`)
            }
        } else if (plugin.plugin_type === 'source' && plugin.source) {
            pluginConfig.vm = createLazyPluginVM(
                server,
                pluginConfig,
                plugin.source,
                '',
                `Loaded plugin "${plugin.name}"!`
            )
            await clearError(server, pluginConfig)
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

export async function runPlugins(server: PluginsServer, event: PluginEvent): Promise<PluginEvent | null> {
    const pluginsToRun = getPluginsForTeam(server, event.team_id)
    let returnedEvent: PluginEvent | null = event

    for (const pluginConfig of pluginsToRun) {
        const processEvent = await pluginConfig.vm?.getProcessEvent()

        if (processEvent) {
            const timer = new Date()

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

        for (const pluginConfig of pluginsToRun) {
            const timer = new Date()
            const processEventBatch = await pluginConfig.vm?.getProcessEventBatch()
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
        const task = await pluginConfig?.vm?.getTask(taskName)
        response = await task?.exec()
    } catch (error) {
        await processError(server, pluginConfigId, error)
        server.statsd?.increment(`plugin.task.${taskName}.${pluginConfigId}.ERROR`)
    }
    server.statsd?.timing(`plugin.task.${taskName}.${pluginConfigId}`, timer)
    return response
}

function getPluginsForTeam(server: PluginsServer, teamId: number): PluginConfig[] {
    return server.pluginConfigsPerTeam.get(teamId) || []
}
