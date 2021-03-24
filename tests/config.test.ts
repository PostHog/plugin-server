import { getDefaultConfig, overrideWithEnv } from '../src/shared/config'

test('overrideWithEnv 1', () => {
    const defaultConfig = getDefaultConfig()
    const env = {
        CLICKHOUSE_SECURE: 'false',
        TASK_TIMEOUT: '177',
        KAFKA_HOSTS: 'example.com',
        BASE_DIR: undefined,
    }
    const config = overrideWithEnv(getDefaultConfig(), env)

    expect(config.CLICKHOUSE_SECURE).toStrictEqual(false)
    expect(config.TASK_TIMEOUT).toStrictEqual(177)
    expect(config.KAFKA_HOSTS).toStrictEqual('example.com')
    expect(config.BASE_DIR).toStrictEqual(defaultConfig.BASE_DIR)
})

test('overrideWithEnv 2', () => {
    const defaultConfig = getDefaultConfig()
    const env = {
        CLICKHOUSE_SECURE: '1',
        TASK_TIMEOUT: '4.5',
    }
    const config = overrideWithEnv(getDefaultConfig(), env)

    expect(config.CLICKHOUSE_SECURE).toStrictEqual(true)
    expect(config.TASK_TIMEOUT).toStrictEqual(4.5)
})
