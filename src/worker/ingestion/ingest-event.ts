import { PluginEvent } from '@posthog/plugin-scaffold'
import * as Sentry from '@sentry/node'
import { DateTime } from 'luxon'

import { Hub, IngestEventResponse } from '../../types'
import { timeoutGuard } from '../../utils/db/utils'
import { status } from '../../utils/status'
import { postEventToWebhook } from './webhooks'

export async function ingestEvent(hub: Hub, event: PluginEvent): Promise<IngestEventResponse> {
    const timeout = timeoutGuard('Still ingesting event inside worker. Timeout warning after 30 sec!', {
        event: JSON.stringify(event),
    })
    try {
        const { ip, site_url, team_id, now, sent_at, uuid } = event
        const distinctId = String(event.distinct_id)
        const result = await hub.eventsProcessor.processEvent(
            distinctId,
            ip,
            site_url,
            event,
            team_id,
            DateTime.fromISO(now),
            sent_at ? DateTime.fromISO(sent_at) : null,
            uuid! // it will throw if it's undefined
        )
        if (hub.PLUGIN_SERVER_ACTION_MATCHING >= 1 && result) {
            const person = await hub.db.fetchPerson(team_id, distinctId)
            const actionMatches = await hub.actionMatcher.match(event, person, result.elements)
            const team = await hub.teamManager.fetchTeam(event.team_id)
            const webhookUrl = team?.slack_incoming_webhook
            if (webhookUrl) {
                await Promise.all(
                    actionMatches
                        .filter((action) => action.post_to_slack)
                        .map((action) => postEventToWebhook(webhookUrl, action, event, person, site_url))
                )
            }
            if (hub.PLUGIN_SERVER_ACTION_MATCHING >= 2 && actionMatches.length && result.eventId !== undefined) {
                await hub.db.registerEventActionOccurrences(result.eventId, actionMatches)
            }
        }
        // We don't want to return the inserted DB entry that `processEvent` returns.
        // This response is passed to piscina and would be discarded anyway.
        return { success: true }
    } catch (e) {
        status.info('🔔', e)
        Sentry.captureException(e)
        return { error: e.message }
    } finally {
        clearTimeout(timeout)
    }
}
