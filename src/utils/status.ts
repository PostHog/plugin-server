import { threadId } from 'worker_threads'

export type StatusMethod = (icon: string, ...message: any[]) => void

export interface StatusBlueprint {
    info: StatusMethod
    warn: StatusMethod
    error: StatusMethod
}

export class Status implements StatusBlueprint {
    prefixOverride?: string

    constructor(prefixOverride?: string) {
        this.prefixOverride = prefixOverride
    }

    determinePrefix(): string {
        return `[${this.prefixOverride ?? (threadId ? threadId.toString().padStart(4, '_') : 'MAIN')}] ${
            new Date().toTimeString().split(' ')[0]
        }`
    }

    buildMethod(type: keyof StatusBlueprint): StatusMethod {
        if (process.env.NODE_ENV?.toLowerCase() === 'test') {
            // TODO: use determineNodeEnv() here
            return () => {} // eslint-disable-line @typescript-eslint/no-empty-function
        }
        return (icon: string, ...message: any[]) => {
            console[type](this.determinePrefix(), icon, ...message.filter(Boolean))
        }
    }

    info = this.buildMethod('info')
    warn = this.buildMethod('warn')
    error = this.buildMethod('error')
}

export const status = new Status()
