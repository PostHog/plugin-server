import { Message } from 'node-rdkafka'
import { DateTime, Duration } from 'luxon'
import { isLooselyFalsy, UUIDT } from './utils'

export type Data = Record<string, any>
export type Properties = Record<string, any>

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
        DateTime.fromISO(event.now),
        event.sent_at ? DateTime.fromISO(event.sent_at) : null
    )
    commit()
}

function processEventEE(
    distinct_id: string,
    ip: string,
    site_url: string,
    data: Data,
    team_id: number,
    now: DateTime,
    sent_at: DateTime | null
): void {
    const properties: Properties = data.properties ?? {}
    if (data['$set']) {
        properties['$set'] = data['$set']
    }

    const person_uuid = new UUIDT()
    const event_uuid = new UUIDT()
    const ts = handle_timestamp(data, now, sent_at)
    // handle_identify_or_alias(data['event'], properties, distinct_id, team_id)

    if (data['event'] === '$snapshot') {
        /*
        create_session_recording_event(
            event_uuid,
            team_id,
            distinct_id,
            properties['$session_id'],
            ts,
            properties['$snapshot_data']
        )
        */
    } else {
        _capture_ee(event_uuid, person_uuid, ip, site_url, team_id, data['event'], distinct_id, properties, ts)
    }
}

function handle_timestamp(data: Data, now: DateTime, sent_at: DateTime | null): DateTime {
    if (data['timestamp']) {
        if (sent_at) {
            // sent_at - timestamp == now - x
            // x = now + (timestamp - sent_at)
            try {
                // timestamp and sent_at must both be in the same format: either both with or both without timezones
                // otherwise we can't get a diff to add to now
                return now.plus(DateTime.fromISO(data['timestamp']).diff(sent_at))
            } catch (error) {
                console.error(error)
            }
        }
        return DateTime.fromISO(data['timestamp'])
    }
    if (!data['offset']) {
        return now.minus(Duration.fromMillis(data['offset']))
    }
    return now
}

/*
function handle_identify_or_alias(event: string, properties: Properties, distinct_id: string, team_id: number): void {
    if (event === "$create_alias") {
        _alias(
            properties["alias"], distinct_id, team_id,
        )
    } else if (event === "$identify") {
        if (properties["$anon_distinct_id"]) {
            _alias(
                properties["$anon_distinct_id"], distinct_id, team_id,
            )
        }
        if (properties["$set"]) {
            _update_person_properties(team_id=team_id, distinct_id=distinct_id, properties=properties["$set"])
        }
        _set_is_identified(team_id=team_id, distinct_id=distinct_id)
    }
}

function _alias(previous_distinct_id: string, distinct_id: string, team_id: number, retry_if_failed = true): void {
    let old_person: Person | null = null
    let new_person: Person | null = null

    try {
        old_person = Person.objects.get(
            team_id=team_id, persondistinctid__team_id=team_id, persondistinctid__distinct_id=previous_distinct_id
        )
    except Person.DoesNotExist:
        pass

    try:
        new_person = Person.objects.get(
            team_id=team_id, persondistinctid__team_id=team_id, persondistinctid__distinct_id=distinct_id
        )
    except Person.DoesNotExist:
        pass

    if old_person and not new_person:
        try:
            old_person.add_distinct_id(distinct_id)
        # Catch race case when somebody already added this distinct_id between .get and .add_distinct_id
        except IntegrityError:
            if retry_if_failed:  # run everything again to merge the users if needed
                _alias(previous_distinct_id, distinct_id, team_id, False)
        return

    if not old_person and new_person:
        try:
            new_person.add_distinct_id(previous_distinct_id)
        # Catch race case when somebody already added this distinct_id between .get and .add_distinct_id
        except IntegrityError:
            if retry_if_failed:  # run everything again to merge the users if needed
                _alias(previous_distinct_id, distinct_id, team_id, False)
        return

    if not old_person and not new_person:
        try:
            Person.objects.create(
                team_id=team_id, distinct_ids=[str(distinct_id), str(previous_distinct_id)],
            )
        # Catch race condition where in between getting and creating, another request already created this user.
        except IntegrityError:
            if retry_if_failed:
                # try once more, probably one of the two persons exists now
                _alias(previous_distinct_id, distinct_id, team_id, False)
        return

    if old_person and new_person and old_person != new_person:
        new_person.merge_people([old_person])
}
*/

interface Element {
    text: string
    tag_name: string
    href: string
    attr_class: string[]
    attr_id: string
    nth_child: number
    nth_of_type: number
    attributes: Record<string, string>
)

function _capture_ee(
    event_uuid: UUIDT,
    person_uuid: UUIDT,
    ip: string,
    site_url: string,
    team_id: number,
    event: string,
    distinct_id: string,
    properties: Properties,
    timestamp: DateTime,
): void {
    const elements: Record<string, any>[] = properties.elements
    let elements_list: Element[] = []
    if (!isLooselyFalsy(elements)) {
        delete properties["$elements"]
        elements_list = elements.map((el, index) => ({
            text: el["$el_text"] ? el["$el_text"].slice(0, 400) : null,
            tag_name: el["tag_name"],
            href: el["attr__href"] ? el["attr__href"].slice(0, 2048) : null,
            attr_class: el["attr__class"] ? el["attr__class"].split(" ") : null,
            attr_id: el["attr__id"],
            nth_child: el["nth_child"],
            nth_of_type: el["nth_of_type"],
            attributes: Object.fromEntries(Object.entries(el).filter(([key]) => key.startsWith("attr__")))
        }))
    }

    const team = Team.objects.only(
        "slack_incoming_webhook",
        "event_names",
        "event_properties",
        "event_names_with_usage",
        "event_properties_with_usage",
        "anonymize_ips",
    ).get(pk=team_id)

    if (!team.anonymize_ips && !("$ip" in properties)) {
        properties["$ip"] = ip
    }

    store_names_and_properties(team=team, event=event, properties=properties)

    if not Person.objects.distinct_ids_exist(team_id=team_id, distinct_ids=[str(distinct_id)]):
        # Catch race condition where in between getting and creating,
        # another request already created this user
        try:
            Person.objects.create(team_id=team_id, distinct_ids=[str(distinct_id)])
        except IntegrityError:
            pass

    # # determine create events
    create_event(
        event_uuid=event_uuid,
        event=event,
        properties=properties,
        timestamp=timestamp,
        team=team,
        distinct_id=distinct_id,
        elements=elements_list,
        site_url=site_url,
    )
}
