import { PluginEvent } from '@posthog/plugin-scaffold'
import { DateTime, Duration } from 'luxon'
import { PluginsServer, EventData, Properties, Element, Team, Person, PersonDistinctId, CohortPeople } from 'types'
import { castTimestampOrNow, UUID, UUIDT } from '../utils'
import { elements_to_string } from './element'
import { Event as EventProto } from '../idl/protos'

export class EventsProcessor {
    pluginsServer: PluginsServer

    constructor(pluginsServer: PluginsServer) {
        this.pluginsServer = pluginsServer
    }

    async process_event_ee(
        distinct_id: string,
        ip: string,
        site_url: string,
        data: PluginEvent,
        team_id: number,
        now: DateTime,
        sent_at: DateTime | null
    ): Promise<void> {
        const properties: Properties = data.properties ?? {}
        if (data['$set']) {
            properties['$set'] = data['$set']
        }

        const person_uuid = new UUIDT()
        const event_uuid = new UUIDT()
    }
}
