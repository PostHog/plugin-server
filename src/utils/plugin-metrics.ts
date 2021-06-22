import Piscina from '@posthog/piscina'

import { Hub, PluginConfig, PluginConfigId } from './../types'
import { createPosthog } from './../worker/vm/extensions/posthog'
import { UUIDT } from './utils'

interface PluginMetrics {
    pluginConfig: PluginConfig
    metrics: Record<string, number>
}

export class PluginMetricsManager {
    metricsPerPlugin: Record<PluginConfigId, PluginMetrics>

    constructor() {
        this.metricsPerPlugin = {}
    }

    sendPluginMetrics(hub: Hub): void {
        for (const plugin of Object.values(this.metricsPerPlugin)) {
            const config = plugin.pluginConfig
            const posthog = createPosthog(hub, config)
            posthog.capture(`$plugin_metrics`, {
                ...plugin.metrics,
                plugin_name: config.plugin!.name,
                plugin_id: config.plugin!.id,
                plugin_tag: config.plugin!.tag,
            })
        }
        this.metricsPerPlugin = {}
    }

    setupMetricsObjectIfNeeded(pluginConfig: PluginConfig): void {
        if (!pluginConfig.plugin) {
            throw new Error('no plugin for config')
        }
        if (!this.metricsPerPlugin[pluginConfig.id]) {
            this.metricsPerPlugin[pluginConfig.id] = {
                pluginConfig,
                metrics: {},
            } as PluginMetrics
        }
    }

    increment(pluginConfig: PluginConfig, metricName: string, value: number): void {
        this.setupMetricsObjectIfNeeded(pluginConfig)
        const currentMetric = this.metricsPerPlugin[pluginConfig.id].metrics[metricName]
        if (!currentMetric) {
            this.metricsPerPlugin[pluginConfig.id].metrics[metricName] = value
            return
        }
        this.metricsPerPlugin[pluginConfig.id].metrics[metricName] += value
    }

    max(pluginConfig: PluginConfig, metricName: string, value: number): void {
        this.setupMetricsObjectIfNeeded(pluginConfig)
        const currentMetric = this.metricsPerPlugin[pluginConfig.id].metrics[metricName]
        if (!currentMetric) {
            this.metricsPerPlugin[pluginConfig.id].metrics[metricName] = value
            return
        }
        this.metricsPerPlugin[pluginConfig.id].metrics[metricName] = Math.max(value, currentMetric)
    }

    min(pluginConfig: PluginConfig, metricName: string, value: number): void {
        this.setupMetricsObjectIfNeeded(pluginConfig)
        const currentMetric = this.metricsPerPlugin[pluginConfig.id].metrics[metricName]
        if (!currentMetric) {
            this.metricsPerPlugin[pluginConfig.id].metrics[metricName] = value
            return
        }
        this.metricsPerPlugin[pluginConfig.id].metrics[metricName] = Math.min(value, currentMetric)
    }
}
