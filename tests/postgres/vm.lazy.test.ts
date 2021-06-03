import { RetryError } from '@posthog/plugin-scaffold'
import { mocked } from 'ts-jest/utils'

import { PluginLogEntrySource, PluginLogEntryType, PluginTaskType } from '../../src/types'
import { clearError, processError } from '../../src/utils/db/error'
import { status } from '../../src/utils/status'
import { delay } from '../../src/utils/utils'
import { LazyPluginVM } from '../../src/worker/vm/lazy'
import { createPluginConfigVM } from '../../src/worker/vm/vm'
import { plugin60 } from '../helpers/plugins'
import { disablePlugin } from '../helpers/sqlMock'
import { plugin70 } from './../helpers/plugins'

jest.mock('../../src/worker/vm/vm')
jest.mock('../../src/utils/db/error')
jest.mock('../../src/utils/status')
jest.mock('../../src/utils/db/sql')

const mockConfig = {
    plugin_id: 60,
    team_id: 2,
    id: 39,
    plugin: { ...plugin60 },
}

describe('LazyPluginVM', () => {
    const createVM = () => new LazyPluginVM()
    const mockServer: any = {
        db: {
            createPluginLogEntry: jest.fn(),
        },
    }
    const initializeVm = (vm: LazyPluginVM) => vm.initialize!(mockServer, mockConfig as any, '', 'some plugin')

    const mockVM = {
        vm: 'vm',
        methods: {
            processEvent: 'processEvent',
        },
        tasks: {
            schedule: {
                runEveryMinute: 'runEveryMinute',
            },
        },
    }

    describe('VM creation succeeds', () => {
        beforeEach(() => {
            mocked(createPluginConfigVM).mockResolvedValue(mockVM as any)
        })

        it('returns correct values for get methods', async () => {
            const vm = createVM()
            void initializeVm(vm)

            expect(await vm.getProcessEvent()).toEqual('processEvent')
            expect(await vm.getTask('someTask', PluginTaskType.Schedule)).toEqual(null)
            expect(await vm.getTask('runEveryMinute', PluginTaskType.Schedule)).toEqual('runEveryMinute')
            expect(await vm.getTasks(PluginTaskType.Schedule)).toEqual(mockVM.tasks.schedule)
        })

        it('logs info and clears errors on success', async () => {
            const vm = createVM()
            void initializeVm(vm)
            await vm.resolveInternalVm

            expect(status.info).toHaveBeenCalledWith('🔌', 'Loaded some plugin')
            expect(clearError).toHaveBeenCalledWith(mockServer, mockConfig)
            expect(mockServer.db.createPluginLogEntry).toHaveBeenCalledWith(
                mockConfig,
                PluginLogEntrySource.System,
                PluginLogEntryType.Info,
                expect.stringContaining('Plugin loaded'),
                undefined
            )
        })
    })

    describe('VM creation fails', () => {
        const error = new Error()
        const retryError = new RetryError('I failed, please retry me!')
        jest.useFakeTimers()

        const mockFailureConfig = {
            plugin_id: 70,
            team_id: 2,
            id: 35,
            plugin: { ...plugin70 },
        }

        it('returns empty values for get methods', async () => {
            mocked(createPluginConfigVM).mockRejectedValue(error)

            const vm = createVM()
            void initializeVm(vm)

            expect(await vm.getProcessEvent()).toEqual(null)
            expect(await vm.getTask('runEveryMinute', PluginTaskType.Schedule)).toEqual(null)
            expect(await vm.getTasks(PluginTaskType.Schedule)).toEqual({})
        })

        it('vm init retries 15x with exponential backoff before disabling plugin', async () => {
            // throw a RetryError setting up the vm
            mocked(createPluginConfigVM).mockRejectedValue(retryError)

            const vm = createVM()
            await vm.initialize!(mockServer, mockFailureConfig as any, 'some log info', 'failure plugin')

            // try to initialize the vm 16 times (1 try + 15 retries)
            await vm.resolveInternalVm
            for (let i = 0; i < 16; ++i) {
                jest.runOnlyPendingTimers()
                await vm.resolveInternalVm
            }

            // plugin setup is retried 15 times with exponential backoff
            expect((status.warn as any).mock.calls).toEqual([
                ['⚠️', 'I failed, please retry me!'],
                ['⚠️', 'Failed to load failure plugin. Retrying to initialize it in 6s.'],
                ['⚠️', 'I failed, please retry me!'],
                ['⚠️', 'Failed to load failure plugin. Retrying to initialize it in 12s.'],
                ['⚠️', 'I failed, please retry me!'],
                ['⚠️', 'Failed to load failure plugin. Retrying to initialize it in 24s.'],
                ['⚠️', 'I failed, please retry me!'],
                ['⚠️', 'Failed to load failure plugin. Retrying to initialize it in 48s.'],
                ['⚠️', 'I failed, please retry me!'],
                ['⚠️', 'Failed to load failure plugin. Retrying to initialize it in 96s.'],
                ['⚠️', 'I failed, please retry me!'],
                ['⚠️', 'Failed to load failure plugin. Retrying to initialize it in 192s.'],
                ['⚠️', 'I failed, please retry me!'],
                ['⚠️', 'Failed to load failure plugin. Retrying to initialize it in 384s.'],
                ['⚠️', 'I failed, please retry me!'],
                ['⚠️', 'Failed to load failure plugin. Retrying to initialize it in 768s.'],
                ['⚠️', 'I failed, please retry me!'],
                ['⚠️', 'Failed to load failure plugin. Retrying to initialize it in 1536s.'],
                ['⚠️', 'I failed, please retry me!'],
                ['⚠️', 'Failed to load failure plugin. Retrying to initialize it in 3072s.'],
                ['⚠️', 'I failed, please retry me!'],
                ['⚠️', 'Failed to load failure plugin. Retrying to initialize it in 6144s.'],
                ['⚠️', 'I failed, please retry me!'],
                ['⚠️', 'Failed to load failure plugin. Retrying to initialize it in 12288s.'],
                ['⚠️', 'I failed, please retry me!'],
                ['⚠️', 'Failed to load failure plugin. Retrying to initialize it in 24576s.'],
                ['⚠️', 'I failed, please retry me!'],
                ['⚠️', 'Failed to load failure plugin. Retrying to initialize it in 49152s.'],
                ['⚠️', 'I failed, please retry me!'],
                [
                    '⚠️',
                    'Failed to load failure plugin. The server tried to initialize it 15 times before disabling it.',
                ],
            ])

            // plugin gets disabled
            expect(disablePlugin).toHaveBeenCalledTimes(1)
            expect(disablePlugin).toHaveBeenCalledWith(mockServer, 35)
        })

        it('vm init will retry on error and load plugin successfully on a retry', async () => {
            // throw a RetryError setting up the vm
            mocked(createPluginConfigVM).mockRejectedValueOnce(retryError)

            const vm = createVM()
            await vm.initialize!(mockServer, mockFailureConfig as any, 'some log info', 'failure plugin')
            await vm.resolveInternalVm

            // retry mechanism is called based on the error
            expect((status.warn as any).mock.calls).toEqual([
                ['⚠️', 'I failed, please retry me!'],
                ['⚠️', 'Failed to load failure plugin. Retrying to initialize it in 6s.'],
            ])

            // do not fail on the second try
            mocked(createPluginConfigVM).mockResolvedValue(mockVM as any)
            jest.runOnlyPendingTimers()
            await vm.resolveInternalVm

            // load plugin successfully
            expect((status.info as any).mock.calls).toEqual([['🔌', 'Loaded failure plugin']])

            // plugin doesn't get disabled
            expect(disablePlugin).toHaveBeenCalledTimes(0)
        })
    })
})
