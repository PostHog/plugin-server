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
        // flush logs immediately on tests
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
        if (this.flushTimeout) {
            clearTimeout(this.flushTimeout)
            this.flushTimeout = null
        }
        if (this.logs.length > 0) {
            await this.db.createPluginLogEntries(this.logs)
            this.logs = []
        }
    }
}
