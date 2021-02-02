import { createProcessEventTests } from '../shared/process-event'

jest.setTimeout(600000) // 600 sec timeout

describe('process event (postgresql)', () => {
    createProcessEventTests('postgresql')
})
