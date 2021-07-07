import { determineNodeEnv, NodeEnv } from '../utils'
import { DB, LogEntryPayload, ParsedLogEntry } from './db'

export class PostgresLogsWrapper {
    logs: ParsedLogEntry[]
    flushTimeout: NodeJS.Timeout | null
    db: DB

    constructor(db: DB) {
        this.db = db
        this.logs = []
        this.flushTimeout = null
    }

    async addLog(log: ParsedLogEntry): Promise<void> {
        // for postgres logs, buffer them
        this.logs.push(log)

        // flush logs immediately on tests
        if (determineNodeEnv() === NodeEnv.Test) {
            await this.flushLogs()
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
            await this.db.batchInsertPostgresLogs(this.logs)
            this.logs = []
        }
    }
}
