import { Hub, PluginConfig } from '../../../types'

type MetricsOperations = {
    increment: (metricName: string, value: number) => Promise<void>
}
type Metrics = Record<string, MetricsOperations>

export function createMetrics(hub: Hub, pluginConfig: PluginConfig): Metrics {
    return new Proxy(
        {},
        {
            get(target, key) {
                if (typeof key !== 'string' || !Object.keys(pluginConfig.plugin?.metrics || {}).includes(key)) {
                    throw new Error('Invalid metric name')
                }
                return {
                    increment: (value: number) => {
                        hub.pluginMetricsManager.increment(pluginConfig, key, value)
                    },
                }
            },
        }
    )
}
