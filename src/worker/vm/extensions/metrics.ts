import { Hub, MetricMathOperations, PluginConfig } from '../../../types'

type MetricsOperations = {
    increment: (metricName: string, value: number) => Promise<void>
}
type Metrics = Record<string, MetricsOperations>

export function createMetrics(hub: Hub, pluginConfig: PluginConfig): Metrics {
    return new Proxy(
        {},
        {
            get(_, key) {
                if (typeof key !== 'string' || !Object.keys(pluginConfig.plugin?.metrics || {}).includes(key)) {
                    throw new Error('Invalid metric name')
                }
                const defaultOptions = {
                    metricName: key,
                    pluginConfig,
                }
                return {
                    increment: (value: number) => {
                        hub.pluginMetricsManager.updateMetric({
                            value,
                            metricOperation: MetricMathOperations.Increment,
                            ...defaultOptions,
                        })
                    },
                    max: (value: number) => {
                        hub.pluginMetricsManager.updateMetric({
                            value,
                            metricOperation: MetricMathOperations.Max,
                            ...defaultOptions,
                        })
                    },
                    min: (value: number) => {
                        hub.pluginMetricsManager.updateMetric({
                            value,
                            metricOperation: MetricMathOperations.Min,
                            ...defaultOptions,
                        })
                    },
                }
            },
        }
    )
}
