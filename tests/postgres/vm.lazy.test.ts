import { mocked } from 'ts-jest/utils'

import { clearError, processError } from '../../src/error'
import { status } from '../../src/status'
import { LazyPluginVM } from '../../src/types'
import { createLazyPluginVM } from '../../src/vm/lazy'
import { createPluginConfigVM } from '../../src/vm/vm'

jest.mock('../../src/vm/vm')
jest.mock('../../src/error')
jest.mock('../../src/status')

describe('createLazyPluginVM()', () => {
    const createVM = () => createLazyPluginVM()
    const initializeVM = (vm: LazyPluginVM) =>
        vm.initialize('mockServer' as any, 'mockConfig' as any, '', 'some plugin')

    describe('VM creation succeeds', () => {
        const mockVM = {
            vm: 'vm',
            methods: {
                processEvent: 'processEvent',
            },
            tasks: {
                runEveryMinute: 'runEveryMinute',
            },
        }

        beforeEach(() => {
            mocked(createPluginConfigVM).mockResolvedValue(mockVM as any)
        })

        it('returns correct values for get methods', async () => {
            const vm = createVM()
            void initializeVM(vm)

            expect(await vm.getProcessEvent()).toEqual('processEvent')
            expect(await vm.getProcessEventBatch()).toEqual(null)
            expect(await vm.getTask('someTask')).toEqual(null)
            expect(await vm.getTask('runEveryMinute')).toEqual('runEveryMinute')
            expect(await vm.getTasks()).toEqual(mockVM.tasks)
        })

        it('logs info and clears errors on success', async () => {
            const vm = createVM()
            void initializeVM(vm)
            await vm.promise

            expect(status.info).toHaveBeenCalledWith('🔌', 'Loaded some plugin')
            expect(clearError).toHaveBeenCalledWith('mockServer', 'mockConfig')
        })
    })

    describe('VM creation fails', () => {
        const error = new Error()

        beforeEach(() => {
            mocked(createPluginConfigVM).mockRejectedValue(error)

            jest.spyOn(console, 'warn').mockImplementation(() => null)
        })

        it('returns empty values for get methods', async () => {
            const vm = createVM()
            void initializeVM(vm)

            expect(await vm.getProcessEvent()).toEqual(null)
            expect(await vm.getProcessEventBatch()).toEqual(null)
            expect(await vm.getTask('runEveryMinute')).toEqual(null)
            expect(await vm.getTasks()).toEqual({})
        })

        it('logs failure', async () => {
            try {
                const vm = createVM()
                void initializeVM(vm)
                await vm.promise
            } catch {}

            expect(console.warn).toHaveBeenCalledWith('⚠️ Failed to load some plugin')
            expect(processError).toHaveBeenCalledWith('mockServer', 'mockConfig', error)
        })
    })
})
