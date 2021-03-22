import { Properties } from '@posthog/plugin-scaffold'
import { nodePostHog } from 'posthog-js-lite/dist/src/targets/node'
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

    public async updateEventNamesAndProperties(
        teamId: number,
        event: string,
        properties: Properties,
        posthog: ReturnType<typeof nodePostHog>
    ): Promise<void> {
        const team = await this.fetchTeam(teamId)

        if (!team) {
            return
        }

        const timeout = timeoutGuard('Still running "updateEventNamesAndProperties". Timeout warning after 30 sec!', {
            event: event,
            ingested: team.ingested_event,
        })
        // In _capture we only prefetch a couple of fields in Team to avoid fetching too much data
        let save = false
        if (!team.ingested_event) {
            // First event for the team captured
            const organizationMembers = await this.db.postgresQuery(
                'SELECT distinct_id FROM posthog_user JOIN posthog_organizationmembership ON posthog_user.id = posthog_organizationmembership.user_id WHERE organization_id = $1',
                [team.organization_id],
                'posthog_organizationmembership'
            )
            const distinctIds: { distinct_id: string }[] = organizationMembers.rows
            for (const { distinct_id } of distinctIds) {
                posthog.identify(distinct_id)
                posthog.capture('first team event ingested', { team: team.uuid })
            }
            team.ingested_event = true
            save = true
        }
        if (team.event_names && !team.event_names.includes(event)) {
            save = true
            team.event_names.push(event)
            team.event_names_with_usage.push({ event: event, usage_count: null, volume: null })
        }
        for (const [key, value] of Object.entries(properties)) {
            if (team.event_properties && !team.event_properties.includes(key)) {
                team.event_properties.push(key)
                team.event_properties_with_usage.push({ key: key, usage_count: null, volume: null })
                save = true
            }
            if (
                typeof value === 'number' &&
                team.event_properties_numerical &&
                !team.event_properties_numerical.includes(key)
            ) {
                team.event_properties_numerical.push(key)
                save = true
            }
        }
        if (save) {
            const timeout2 = timeoutGuard(
                'Still running "updateEventNamesAndProperties" save. Timeout warning after 30 sec!',
                { event }
            )
            await this.db.postgresQuery(
                `UPDATE posthog_team SET
                    ingested_event = $1, event_names = $2, event_names_with_usage = $3, event_properties = $4,
                    event_properties_with_usage = $5, event_properties_numerical = $6
                WHERE id = $7`,
                [
                    team.ingested_event,
                    JSON.stringify(team.event_names),
                    JSON.stringify(team.event_names_with_usage),
                    JSON.stringify(team.event_properties),
                    JSON.stringify(team.event_properties_with_usage),
                    JSON.stringify(team.event_properties_numerical),
                    team.id,
                ],
                'updateEventNamesAndProperties'
            )
            clearTimeout(timeout2)
        }
        clearTimeout(timeout)
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
