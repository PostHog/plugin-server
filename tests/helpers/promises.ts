interface MockPromise<T> {
    promise: Promise<T>
    resolve: (value?: any) => void
    reject: (error: any) => void
}

export function createPromise<T = void>(): MockPromise<T> {
    let resolve: (value?: any) => void
    let reject: (error: any) => void

    const promise = new Promise<T>((_resolve, _reject) => {
        resolve = _resolve
        reject = _reject
    })

    return { promise, resolve, reject }
}
