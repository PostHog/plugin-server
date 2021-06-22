import Piscina from '@posthog/piscina'

import { Hub, MetricMathOperations, PluginConfig, PluginConfigId } from './../types'
import { createPosthog } from './../worker/vm/extensions/posthog'
import { UUIDT } from './utils'

interface PluginMetrics {
    pluginConfig: PluginConfig
    metrics: Record<string, number>
}

interface UpdateMetricPayload {
    pluginConfig: PluginConfig
    metricOperation: MetricMathOperations
    metricName: string
    value: number
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

    updateMetric({ metricOperation, pluginConfig, metricName, value }: UpdateMetricPayload) {
        if (typeof value !== 'number') {
            throw new Error('Only numbers are allowed for operations on metrics')
        }
        this.setupMetricsObjectIfNeeded(pluginConfig)
        const currentMetric = this.metricsPerPlugin[pluginConfig.id].metrics[metricName]
        if (!currentMetric) {
            this.metricsPerPlugin[pluginConfig.id].metrics[metricName] = value
            return
        }
        switch (metricOperation) {
            case MetricMathOperations.Increment:
                this.metricsPerPlugin[pluginConfig.id].metrics[metricName] += value
                break
            case MetricMathOperations.Max:
                this.metricsPerPlugin[pluginConfig.id].metrics[metricName] = Math.max(value, currentMetric)
                break
            case MetricMathOperations.Min:
                this.metricsPerPlugin[pluginConfig.id].metrics[metricName] = Math.min(value, currentMetric)
                break
            default:
                throw new Error('Unsupported metric math operation!')
        }
    }
}
