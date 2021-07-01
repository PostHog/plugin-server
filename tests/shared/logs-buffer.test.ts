import { PluginConfig, PluginLogEntrySource, PluginLogEntryType, PropertyOperator } from '../../src/types'
import { LogsBuffer } from '../../src/utils/logs-buffer'
import { UUIDT } from '../../src/utils/utils'

describe('LogsBuffer', () => {
    let logsBuffer: LogsBuffer
    let db: any

    beforeEach(() => {
        db = {
            createPluginLogEntries: jest.fn(),
        } as any
        logsBuffer = new LogsBuffer(db)
    })

    test('logsBuffer adds and flushes logs correctly', async () => {
        jest.useFakeTimers()
        logsBuffer.addLog({
            pluginConfig: { id: 39, team_id: 2, plugin: { id: 60, organization_id: 'bla' } } as PluginConfig,
            message: 'plugin loaded',
            source: PluginLogEntrySource.System,
            type: PluginLogEntryType.Info,
            instanceId: new UUIDT(),
        })
        expect(logsBuffer.logs).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    pluginConfig: { id: 39, team_id: 2, plugin: { id: 60 } },
                    message: 'plugin loaded',
                    source: 'SYSTEM',
                    type: 'INFO',
                    instanceId: expect.any(UUIDT),
                }),
            ])
        )
        expect(logsBuffer.flushTimeout).toBeTruthy()
        await logsBuffer.flushLogs()
        expect(db.createPluginLogEntries).toHaveBeenCalled()
        expect(logsBuffer.logs).toEqual([])
        expect(logsBuffer.flushTimeout).toEqual(null)
    })
})
