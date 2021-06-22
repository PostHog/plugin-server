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
                const availabeMetrics = pluginConfig.plugin?.metrics || {}

                if (typeof key !== 'string' || !Object.keys(availabeMetrics).includes(key)) {
                    throw new Error('Invalid metric name')
                }
                const defaultOptions = {
                    metricName: key,
                    pluginConfig,
                }

                if (availabeMetrics[key].toLowerCase() === 'sum') {
                    return {
                        increment: (value: number) => {
                            hub.pluginMetricsManager.updateMetric({
                                value,
                                metricOperation: MetricMathOperations.Increment,
                                ...defaultOptions,
                            })
                        },
                    }
                }

                if (availabeMetrics[key].toLowerCase() === 'max') {
                    return {
                        max: (value: number) => {
                            hub.pluginMetricsManager.updateMetric({
                                value,
                                metricOperation: MetricMathOperations.Max,
                                ...defaultOptions,
                            })
                        },
                    }
                }

                if (availabeMetrics[key].toLowerCase() === 'min') {
                    return {
                        min: (value: number) => {
                            hub.pluginMetricsManager.updateMetric({
                                value,
                                metricOperation: MetricMathOperations.Min,
                                ...defaultOptions,
                            })
                        },
                    }
                }

                return {}
            },
        }
    )
}
