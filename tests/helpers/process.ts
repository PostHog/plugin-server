export function mockKill(): typeof process {
    const realProcess = process
    const killMock = jest.fn()

    beforeAll(() => {
        global.process = new Proxy(process, {
            get(target, property: keyof typeof process) {
                if (property === 'kill') {
                    return killMock
                }
                return realProcess[property]
            },
        })
    })

    afterAll(() => {
        global.process = realProcess
    })

    return (killMock as any) as typeof process
}
