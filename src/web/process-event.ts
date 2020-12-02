import { Message } from 'node-rdkafka'
import { UUIDT } from './utils'

export type Data = Record<string, any>

export interface PostHogEvent {
    distinct_id: string
    ip: string
    site_url: string
    data: Data
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
    data: Data,
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

function handle_timestamp(data: Data, now: Date, sent_at: Date | null): Date {
    if (data['timestamp']) {
        if (sent_at) {
            // sent_at - timestamp == now - x
            // x = now + (timestamp - sent_at)
            try {
                // timestamp and sent_at must both be in the same format: either both with or both without timezones
                // otherwise we can't get a diff to add to now
                return now + (new Date(data['timestamp']) - sent_at)
            } catch (e) {
                capture_exception(e)
            }
        }
        return new Date(data['timestamp'])
    }
    if (!data['offset']) {
        return now - relativedelta((microseconds = data['offset'] * 1000))
    }
    return now
}
