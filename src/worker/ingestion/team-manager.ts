import { DB } from 'shared/db'
import { timeoutGuard } from 'shared/ingestion/utils'
import { Team, TeamId } from 'types'

export class TeamManager {
    db: DB
    teamCache: Map<TeamId, [Team | null, Date]>
    shouldSendWebhooksCache: Map<TeamId, [boolean, Date]>

    constructor(db: DB) {
        this.db = db
        this.teamCache = new Map()
        this.shouldSendWebhooksCache = new Map()
    }

    public async fetchTeam(teamId: number): Promise<Team | null> {
        const cachedTeam = this.getByAge(this.teamCache, teamId)
        if (cachedTeam) {
            return cachedTeam
        }

        const timeout = timeoutGuard(`Still running "fetchTeam". Timeout warning after 30 sec!`)
        try {
            const teamQueryResult = await this.db.postgresQuery(
                'SELECT * FROM posthog_team WHERE id = $1',
                [teamId],
                'selectTeam'
            )
            const team: Team | null = teamQueryResult.rows[0]

            this.teamCache.set(teamId, [team, new Date()])
            return team
        } finally {
            clearTimeout(timeout)
        }
    }

    public async shouldSendWebhooks(teamId: number): Promise<boolean> {
        const cachedValue = this.getByAge(this.shouldSendWebhooksCache, teamId)
        if (cachedValue !== undefined) {
            return cachedValue
        }

        const team = await this.fetchTeam(teamId)
        if (!team || !team.slack_incoming_webhook) {
            return false
        }

        const timeout = timeoutGuard(`Still running "shouldSendWebhooks". Timeout warning after 30 sec!`)
        try {
            const hookQueryResult = await this.db.postgresQuery(
                `SELECT COUNT(*) FROM ee_hook WHERE team_id = $1 AND event = 'action_performed' LIMIT 1`,
                [team.id],
                'shouldSendHooksTask'
            )
            const hasHooks = parseInt(hookQueryResult.rows[0].count) > 0
            this.shouldSendWebhooksCache.set(teamId, [hasHooks, new Date()])
            return hasHooks
        } catch (error) {
            // In FOSS PostHog ee_hook does not exist. If the error is other than that, rethrow it
            if (!String(error).includes('relation "ee_hook" does not exist')) {
                throw error
            }
            return false
        } finally {
            clearTimeout(timeout)
        }
    }

    private getByAge<K, V>(cache: Map<K, [V, Date]>, key: K, maxAgeMs = 30000): V | undefined {
        if (cache.has(key)) {
            const [value, age] = cache.get(key)!
            if (new Date().getTime() - age.getTime() <= maxAgeMs) {
                return value
            }
        }
        return undefined
    }
}
