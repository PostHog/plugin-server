import { DB, LogEntryPayload } from './db/db'
import { determineNodeEnv, NodeEnv } from './utils'

export class LogsBuffer {
    logs: LogEntryPayload[]
    flushTimeout: NodeJS.Timeout | null
    db: DB

    constructor(db: DB) {
        this.db = db
        this.logs = []
        this.flushTimeout = null
    }

    addLog(log: LogEntryPayload): void {
        this.logs.push(log)
        if (determineNodeEnv() === NodeEnv.Test) {
            void this.flushLogs()
            return
        }
        if (!this.flushTimeout) {
            this.flushTimeout = setTimeout(async () => {
                await this.flushLogs()
            }, 1000)
        }
    }

    async flushLogs(): Promise<void> {
        await this.db.createPluginLogEntries(this.logs)
        this.logs = []
        this.flushTimeout = null
    }
}
