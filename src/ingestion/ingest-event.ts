import { PluginEvent } from '@posthog/plugin-scaffold'
import { DateTime } from 'luxon'

import { PluginsServer } from '../types'

export async function ingestEvent(server: PluginsServer, event: PluginEvent) {
    const { distinct_id, ip, site_url, team_id, now, sent_at, uuid } = event
    await server.eventsProcessor.processEvent(
        distinct_id,
        ip,
        site_url,
        event,
        team_id,
        DateTime.fromISO(now),
        sent_at ? DateTime.fromISO(sent_at) : null,
        uuid! // it will throw if it's undefined
    )
}
