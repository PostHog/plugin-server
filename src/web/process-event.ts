import { Message } from 'node-rdkafka'
import { UUIDT } from './utils'

export interface PostHogEvent {
    distinct_id: string
    ip: string
    site_url: string
    data: Record<string, any>
    team_id: number
    now: string
    sent_at: string
}

export function processEventFromKafka(message: Message, commit: () => void): void {
    // TODO: time with statsd
    const event = JSON.parse(message.value!.toString()) as PostHogEvent
    processEventEE(
        event.distinct_id,
        event.ip,
        event.site_url,
        event.data,
        event.team_id,
        new Date(event.now),
        event.sent_at ? new Date(event.sent_at) : null
    )
    commit()
}

function processEventEE(
    distinct_id: string,
    ip: string,
    site_url: string,
    data: Record<string, any>,
    team_id: number,
    now: Date,
    sent_at: Date | null
): void {
    const properties: Record<string, any> = data.properties ?? {}
    if (data['$set']) {
        properties['$set'] = data['$set']
    }

    const person_uuid = new UUIDT()
    const event_uuid = new UUIDT()
    const ts = handle_timestamp(data, now, sent_at)
    handle_identify_or_alias(data['event'], properties, distinct_id, team_id)

    if (data['event'] === '$snapshot') {
        create_session_recording_event(
            event_uuid,
            team_id,
            distinct_id,
            properties['$session_id'],
            ts,
            properties['$snapshot_data']
        )
    } else {
        _capture_ee(event_uuid, person_uuid, ip, site_url, team_id, data['event'], distinct_id, properties, ts)
    }
}
