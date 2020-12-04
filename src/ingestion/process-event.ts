import { KafkaConsumer } from 'node-rdkafka'
import { DateTime, Duration } from 'luxon'
import { UUID, UUIDT } from './utils'
import { PluginsServer, Data, Properties, Element, Team, Event, Person } from 'types'
import { KAFKA_EVENTS_WAL } from './topics'

export class EventsProcessor {
    pluginsServer: PluginsServer
    kafkaConsumer: KafkaConsumer

    constructor(pluginsServer: PluginsServer) {
        this.pluginsServer = pluginsServer
        this.kafkaConsumer = this.buildKafkaConsumer()
    }

    buildKafkaConsumer(): KafkaConsumer {
        const kafkaConsumer = new KafkaConsumer(
            {
                'metadata.broker.list': this.pluginsServer.KAFKA_HOSTS,
            },
            {
                'auto.offset.reset': 'earliest',
            }
        )

        kafkaConsumer
            .on('ready', () => {
                kafkaConsumer.subscribe([KAFKA_EVENTS_WAL])
                kafkaConsumer.consume()
                console.info(`✅ Kafka consumer ready and subscribed to topic ${KAFKA_EVENTS_WAL}!`)
            })
            .on('disconnected', () => {
                console.info(`🛑 Kafka consumer disconnected!`)
            })
            .on('data', async (message) => {
                // TODO: time with statsd
                const event = JSON.parse(message.value!.toString()) as Event
                await this.process_event_ee(
                    event.distinct_id,
                    event.ip,
                    event.site_url,
                    event.data,
                    event.team_id,
                    DateTime.fromISO(event.now),
                    event.sent_at ? DateTime.fromISO(event.sent_at) : null
                )
                kafkaConsumer.commitMessage(message)
            })

        return kafkaConsumer
    }

    /** This must be ran to start consuming events put into Kafka by external web server. */
    connectKafkaConsumer(): void {
        console.info(`⏬ Connecting Kafka consumer...`)
        this.kafkaConsumer.connect()
    }

    async process_event_ee(
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
        const ts = this.handle_timestamp(data, now, sent_at)
        // TODO: this.handle_identify_or_alias(data['event'], properties, distinct_id, team_id)

        if (data['event'] === '$snapshot') {
            /* TODO:
            this.create_session_recording_event(
                event_uuid,
                team_id,
                distinct_id,
                properties['$session_id'],
                ts,
                properties['$snapshot_data']
            )
            */
        } else {
            await this._capture_ee(
                event_uuid,
                person_uuid,
                ip,
                site_url,
                team_id,
                data['event'],
                distinct_id,
                properties,
                ts,
                sent_at
            )
        }
    }

    handle_timestamp(data: Data, now: DateTime, sent_at: DateTime | null): DateTime {
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

    async _capture_ee(
        event_uuid: UUID,
        person_uuid: UUID,
        ip: string,
        site_url: string,
        team_id: number,
        event: string,
        distinct_id: string,
        properties: Properties,
        timestamp: DateTime,
        sent_at: DateTime
    ): void {
        const elements: Record<string, any>[] | undefined = properties['$elements']
        let elements_list: Element[] = []
        if (elements && elements.length) {
            delete properties['$elements']
            elements_list = elements.map((el) => ({
                text: el['$el_text'] ? el['$el_text'].slice(0, 400) : null,
                tag_name: el['tag_name'],
                href: el['attr__href'] ? el['attr__href'].slice(0, 2048) : null,
                attr_class: el['attr__class'] ? el['attr__class'].split(' ') : null,
                attr_id: el['attr__id'],
                nth_child: el['nth_child'],
                nth_of_type: el['nth_of_type'],
                attributes: Object.fromEntries(Object.entries(el).filter(([key]) => key.startsWith('attr__'))),
            }))
        }
        const {
            rows: [team],
        }: {
            rows: Team[]
        } = await this.pluginsServer.db.query(
            'SELECT slack_incoming_webhook, event_names, event_properties, event_names_with_usage, event_properties_with_usage, anonymize_ips FROM posthog_team WHERE id = $1',
            [team_id]
        )

        if (!team.anonymize_ips && !('$ip' in properties)) {
            properties['$ip'] = ip
        }

        // TODO: store_names_and_properties(team=team, event=event, properties=properties)

        const {
            rows: [{ pdiCount }],
        }: {
            rows: { pdiCount: number }[]
        } = await this.pluginsServer.db.query(
            'SELECT COUNT(*) AS pdiCount FROM posthog_persondistinctid WHERE team_id = $1 AND distinct_id = $2',
            [team_id, distinct_id]
        )

        if (!pdiCount) {
            // Catch race condition where in between getting and creating, another request already created this user
            try {
                const {
                    rows: [personCreated],
                }: {
                    rows: Person[]
                } = await this.pluginsServer.db.query(
                    'INSERT INTO posthog_person (created_at, properties, team_id, is_user_id, is_identified, uuid) VALUES ($1, $2, $3, $4, $5, $6)',
                    [sent_at.toISO(), {}, team_id, null, false, person_uuid.toString()]
                )
                await this.pluginsServer.db.query(
                    'INSERT INTO posthog_persondistinctid (distinct_id, person_id, team_id) VALUES ($1, $2, $3)',
                    [distinct_id, personCreated.id, team_id]
                )
            } catch {}
        }

        this.create_event(
            event_uuid,
            event,
            team,
            distinct_id,
            properties,
            timestamp,
            elements_list,
        )
    }

    create_event(
        event_uuid: UUID,
        event: string,
        team: Team,
        distinct_id: string,
        properties?: Properties,
        timestamp?: DateTime | string,
        elements?: Element[]
    ): void {
        timestamp ??= DateTime.utc()
    
        // ClickHouse specific formatting
        timestamp = typeof timestamp === 'string' ? DateTime.fromISO(timestamp) : timestamp.toUTC()
    
        let elements_chain = elements && elements.length ? elements_to_string(elements=elements) : ''
    
        pb_event = events_pb2.Event()
        pb_event.uuid = str(event_uuid)
        pb_event.event = event
        pb_event.properties = json.dumps(properties ?? {})
        pb_event.timestamp = timestamp.strftime("%Y-%m-%d %H:%M:%S.%f")
        pb_event.team_id = team.pk
        pb_event.distinct_id = str(distinct_id)
        pb_event.elements_chain = elements_chain
        pb_event.created_at = timestamp.strftime("%Y-%m-%d %H:%M:%S.%f")
    
        p = ClickhouseProducer()
    
        p.produce_proto(sql=INSERT_EVENT_SQL, topic=KAFKA_EVENTS, data=pb_event)
    
        return str(event_uuid)
    }
}
