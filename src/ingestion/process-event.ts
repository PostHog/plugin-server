import { KafkaConsumer, LibrdKafkaError, Message, Producer, ProducerStream } from 'node-rdkafka'
import { DateTime, Duration } from 'luxon'
import { PluginsServer, Data, Properties, Element, Team, Person, PersonDistinctId, CohortPeople } from 'types'
import { castTimestampOrNow, UUID, UUIDT } from '../utils'
import { KAFKA_EVENTS, KAFKA_EVENTS_WAL, KAFKA_SESSION_RECORDING_EVENTS } from './topics'
import { elements_to_string } from './element'
import { runPlugins } from '../plugins'
import { PluginEvent } from 'posthog-plugins'
import { Event as EventProto } from '../idl/protos'

export class EventsProcessor {
    pluginsServer: PluginsServer
    kafkaConsumer: KafkaConsumer
    kafkaProducerStreamEvent: ProducerStream
    kafkaProducerStreamSessionRecording: ProducerStream

    constructor(pluginsServer: PluginsServer) {
        this.pluginsServer = pluginsServer
        this.kafkaConsumer = this.buildKafkaConsumer()
        this.kafkaProducerStreamEvent = Producer.createWriteStream(
            {
                'metadata.broker.list': pluginsServer.KAFKA_HOSTS,
            },
            {},
            {
                topic: KAFKA_EVENTS,
            }
        )
        this.kafkaProducerStreamSessionRecording = Producer.createWriteStream(
            {
                'metadata.broker.list': pluginsServer.KAFKA_HOSTS,
            },
            {},
            {
                topic: KAFKA_SESSION_RECORDING_EVENTS,
            }
        )
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

        const processBatch = async (error: LibrdKafkaError, messages: Message[]): Promise<void> => {
            if (error) {
                throw error // TODO: handle errors in a smarter way
            }
            for (const message of messages) {
                const timer = new Date()
                let event: PluginEvent | null = JSON.parse(message.value!.toString()) as PluginEvent
                event = await runPlugins(this.pluginsServer, event)
                if (event) {
                    await this.process_event_ee(
                        event.distinct_id,
                        event.ip,
                        event.site_url,
                        event,
                        event.team_id,
                        DateTime.fromISO(event.now),
                        event.sent_at ? DateTime.fromISO(event.sent_at) : null
                    )
                }
                this.pluginsServer.statsd?.timing(`${this.pluginsServer.STATSD_PREFIX}_posthog_cloud`, timer)
            }
            kafkaConsumer.commit()
        }

        kafkaConsumer
            .on('ready', () => {
                kafkaConsumer.subscribe([KAFKA_EVENTS_WAL])
                // consume event messages in batches of 100
                kafkaConsumer.consume(100, processBatch)
                console.info(`✅ Kafka consumer ready and subscribed to topic ${KAFKA_EVENTS_WAL}!`)
            })
            .on('disconnected', () => {
                console.info(`🛑 Kafka consumer disconnected!`)
            })

        return kafkaConsumer
    }

    /** This must be ran to start consuming events put into Kafka by external web server. */
    connectKafkaConsumer(): void {
        console.info(`⏬ Connecting Kafka consumer...`)
        this.kafkaConsumer.connect()
    }

    stop(): void {
        this.kafkaConsumer.disconnect()
        this.kafkaProducerStreamEvent.destroy()
        this.kafkaProducerStreamSessionRecording.destroy()
    }

    async process_event_ee(
        distinct_id: string,
        ip: string,
        site_url: string,
        data: Data,
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
        const ts = this.handle_timestamp(data, now, sent_at)
        this.handle_identify_or_alias(data['event'], properties, distinct_id, team_id)

        if (data['event'] === '$snapshot') {
            this.create_session_recording_event(
                event_uuid,
                team_id,
                distinct_id,
                properties['$session_id'],
                ts,
                properties['$snapshot_data']
            )
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

    async handle_identify_or_alias(
        event: string,
        properties: Properties,
        distinct_id: string,
        team_id: number
    ): Promise<void> {
        if (event === '$create_alias') {
            await this._alias(properties['alias'], distinct_id, team_id)
        } else if (event === '$identify') {
            if (properties['$anon_distinct_id']) {
                await this._alias(properties['$anon_distinct_id'], distinct_id, team_id)
            }
            if (properties['$set']) {
                this._update_person_properties(team_id, distinct_id, properties['$set'])
            }
            this._set_is_identified(team_id, distinct_id)
        }
    }

    async _set_is_identified(team_id: number, distinct_id: string, is_identified = true): Promise<void> {
        let personFound: Person | undefined
        personFound = (
            await this.pluginsServer.db.query(
                'SELECT posthog_person.id, posthog_person.created_at, posthog_person.team_id, posthog_person.properties, posthog_person.is_user_id, posthog_person.is_identified, posthog_person.uuid, posthog_persondistinctid.team_id AS persondistinctid__team_id, posthog_persondistinctid.distinct_id AS persondistinctid__distinct_id FROM posthog_person JOIN posthog_persondistinctid ON (posthog_persondistinctid.person_id = posthog_person.id) WHERE team_id = $1 AND persondistinctid__team_id = $1 AND persondistinctid__distinct_id = $2',
                [team_id, distinct_id]
            )
        ).rows[0]
        if (!personFound) {
            try {
                const personCreated = await this.create_person(DateTime.utc(), {}, team_id, null, true, new UUIDT())
                this.add_distinct_id(personCreated, distinct_id)
                // Catch race condition where in between getting and creating, another request already created this person
            } catch {
                personFound = (
                    await this.pluginsServer.db.query(
                        'SELECT posthog_person.id, posthog_person.created_at, posthog_person.team_id, posthog_person.properties, posthog_person.is_user_id, posthog_person.is_identified, posthog_person.uuid, posthog_persondistinctid.team_id AS persondistinctid__team_id, posthog_persondistinctid.distinct_id AS persondistinctid__distinct_id FROM posthog_person JOIN posthog_persondistinctid ON (posthog_persondistinctid.person_id = posthog_person.id) WHERE team_id = $1 AND persondistinctid__team_id = $1 AND persondistinctid__distinct_id = $2',
                        [team_id, distinct_id]
                    )
                ).rows[0]
            }
        }
        if (personFound && !personFound.is_identified) {
            await this.pluginsServer.db.query('UPDATE posthog_person SET is_identified = 1 WHERE id = $1', [
                personFound.id,
            ])
        }
    }

    async _update_person_properties(team_id: number, distinct_id: string, properties: Properties): Promise<void> {
        let personFound: Person | undefined
        personFound = (
            await this.pluginsServer.db.query(
                'SELECT posthog_person.id, posthog_person.created_at, posthog_person.team_id, posthog_person.properties, posthog_person.is_user_id, posthog_person.is_identified, posthog_person.uuid, posthog_persondistinctid.team_id AS persondistinctid__team_id, posthog_persondistinctid.distinct_id AS persondistinctid__distinct_id FROM posthog_person JOIN posthog_persondistinctid ON (posthog_persondistinctid.person_id = posthog_person.id) WHERE team_id = $1 AND persondistinctid__team_id = $1 AND persondistinctid__distinct_id = $2',
                [team_id, distinct_id]
            )
        ).rows[0]
        if (!personFound) {
            try {
                const personCreated = await this.create_person(
                    DateTime.utc(),
                    properties,
                    team_id,
                    null,
                    false,
                    new UUIDT()
                )
                await this.add_distinct_id(personCreated, distinct_id)
                // Catch race condition where in between getting and creating, another request already created this person
            } catch {
                personFound = (
                    await this.pluginsServer.db.query(
                        'SELECT posthog_person.id, posthog_person.created_at, posthog_person.team_id, posthog_person.properties, posthog_person.is_user_id, posthog_person.is_identified, posthog_person.uuid, posthog_persondistinctid.team_id AS persondistinctid__team_id, posthog_persondistinctid.distinct_id AS persondistinctid__distinct_id FROM posthog_person JOIN posthog_persondistinctid ON (posthog_persondistinctid.person_id = posthog_person.id) WHERE team_id = $1 AND persondistinctid__team_id = $1 AND persondistinctid__distinct_id = $2',
                        [team_id, distinct_id]
                    )
                ).rows[0]
            }
        }
        if (personFound) {
            this.pluginsServer.db.query('UPDATE posthog_person SET properties = $1 WHERE id = $2', [
                { ...personFound.properties, ...properties },
                personFound.id,
            ])
        }
    }

    async _alias(
        previous_distinct_id: string,
        distinct_id: string,
        team_id: number,
        retry_if_failed = true
    ): Promise<void> {
        const old_person: Person | undefined = (
            await this.pluginsServer.db.query(
                'SELECT posthog_person.id, posthog_person.created_at, posthog_person.team_id, posthog_person.properties, posthog_person.is_user_id, posthog_person.is_identified, posthog_person.uuid, posthog_persondistinctid.team_id AS persondistinctid__team_id, posthog_persondistinctid.distinct_id AS persondistinctid__distinct_id FROM posthog_person JOIN posthog_persondistinctid ON (posthog_persondistinctid.person_id = posthog_person.id) WHERE team_id = $1 AND persondistinctid__team_id = $1 AND persondistinctid__distinct_id = $2',
                [team_id, previous_distinct_id]
            )
        ).rows[0]

        const new_person: Person | undefined = (
            await this.pluginsServer.db.query(
                'SELECT posthog_person.id, posthog_person.created_at, posthog_person.team_id, posthog_person.properties, posthog_person.is_user_id, posthog_person.is_identified, posthog_person.uuid, posthog_persondistinctid.team_id AS persondistinctid__team_id, posthog_persondistinctid.distinct_id AS persondistinctid__distinct_id FROM posthog_person JOIN posthog_persondistinctid ON (posthog_persondistinctid.person_id = posthog_person.id) WHERE team_id = $1 AND persondistinctid__team_id = $1 AND persondistinctid__distinct_id = $2',
                [team_id, distinct_id]
            )
        ).rows[0]

        if (old_person && !new_person) {
            try {
                this.add_distinct_id(old_person, distinct_id)
                // Catch race case when somebody already added this distinct_id between .get and .add_distinct_id
            } catch {
                // integrity error
                if (retry_if_failed) {
                    // run everything again to merge the users if needed
                    this._alias(previous_distinct_id, distinct_id, team_id, false)
                }
            }
            return
        }

        if (!old_person && new_person) {
            try {
                this.add_distinct_id(new_person, previous_distinct_id)
                // Catch race case when somebody already added this distinct_id between .get and .add_distinct_id
            } catch {
                // integrity error
                if (retry_if_failed) {
                    // run everything again to merge the users if needed
                    this._alias(previous_distinct_id, distinct_id, team_id, false)
                }
            }
            return
        }

        if (!old_person && !new_person) {
            try {
                const personCreated = await this.create_person(DateTime.utc(), {}, team_id, null, false, new UUIDT())
                this.add_distinct_id(personCreated, distinct_id)
                this.add_distinct_id(personCreated, previous_distinct_id)
                // Catch race condition where in between getting and creating, another request already created this user.
            } catch {
                // integrity error
                if (retry_if_failed) {
                    // try once more, probably one of the two persons exists now
                    this._alias(previous_distinct_id, distinct_id, team_id, false)
                }
            }
            return
        }

        if (old_person && new_person && old_person.id !== new_person.id) {
            this.merge_people(new_person, [old_person])
        }
    }

    async merge_people(merge_into: Person, people_to_merge: Person[]): Promise<void> {
        let first_seen = merge_into.created_at

        // merge the properties
        for (const other_person of people_to_merge) {
            merge_into.properties = { ...other_person.properties, ...merge_into.properties }
            if (other_person.created_at < first_seen) {
                // Keep the oldest created_at (i.e. the first time we've seen this person)
                first_seen = other_person.created_at
            }
        }

        await this.pluginsServer.db.query('UPDATE posthog_person SET created_at = $1 WHERE id = $2', [
            first_seen.toISO(),
            merge_into.id,
        ])

        // merge the distinct_ids
        for (const other_person of people_to_merge) {
            const other_person_distinct_ids: PersonDistinctId[] = (
                await this.pluginsServer.db.query(
                    'SELECT * FROM posthog_persondistinctid WHERE person_id = $1 AND team_id = $2',
                    [other_person, merge_into.team_id]
                )
            ).rows
            for (const person_distinct_id of other_person_distinct_ids) {
                await this.pluginsServer.db.query('UPDATE posthog_persondistinctid SET person_id = $1 WHERE id = $2', [
                    merge_into.id,
                    person_distinct_id.id,
                ])
            }

            const other_person_cohort_ids: CohortPeople[] = (
                await this.pluginsServer.db.query('SELECT * FROM posthog_cohortpeople WHERE person_id = $1', [
                    other_person.id,
                ])
            ).rows
            for (const person_cohort_id of other_person_cohort_ids) {
                await this.pluginsServer.db.query('UPDATE posthog_cohortpeople SET person_id = $1 WHERE id = $2', [
                    merge_into.id,
                    person_cohort_id.id,
                ])
            }

            await this.pluginsServer.db.query('DELETE FROM posthog_person WHERE id = $1', [other_person.id])
        }
    }

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
        sent_at: DateTime | null
    ): Promise<void> {
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

        this.store_names_and_properties(team, event, properties)

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
                const personCreated: Person = await this.create_person(
                    sent_at || DateTime.utc(),
                    {},
                    team_id,
                    null,
                    false,
                    person_uuid.toString()
                )
                await this.add_distinct_id(personCreated, distinct_id)
            } catch {}
        }

        this.create_event(event_uuid, event, team, distinct_id, properties, timestamp, elements_list)
    }

    async store_names_and_properties(team: Team, event: string, properties: Properties): Promise<void> {
        // In _capture we only prefetch a couple of fields in Team to avoid fetching too much data
        let save = false
        if (!team.ingested_event) {
            // First event for the team captured
            // TODO: capture "first team event ingested"
            team.ingested_event = true
            save = true
        }
        if (!(event in team.event_names)) {
            save = true
            team.event_names.push(event)
            team.event_names_with_usage.push({ event: event, usage_count: null, volume: null })
        }
        for (const [key, value] of Object.entries(properties)) {
            if (!(key in team.event_properties)) {
                team.event_properties.push(key)
                team.event_properties_with_usage.push({ key: key, usage_count: null, volume: null })
                save = true
            }
            if (typeof value === 'number' && !(key in team.event_properties_numerical)) {
                team.event_properties_numerical.push(key)
                save = true
            }
        }
        if (save) {
            await this.pluginsServer.db.query(
                'UPDATE posthog_team SET ingested_event = $1, event_names = $2, event_names_with_usage = $3, event_properties = $4, event_properties_with_usage = $5, event_properties_numerical = $6 WHERE id = $7',
                [
                    team.ingested_event,
                    team.event_names,
                    team.event_names_with_usage,
                    team.event_properties,
                    team.event_names_with_usage,
                    team.event_properties_numerical,
                    team.id,
                ]
            )
        }
    }

    async create_person(
        created_at: DateTime,
        properties: Properties,
        team_id: number,
        is_user_id: number | null,
        is_identified: boolean,
        uuid: UUID | string
    ): Promise<Person> {
        return (
            await this.pluginsServer.db.query(
                'INSERT INTO posthog_person (created_at, properties, team_id, is_user_id, is_identified, uuid) VALUES ($1, $2, $3, $4, $5, $6)',
                [created_at.toISO(), properties, team_id, is_user_id, is_identified, uuid.toString()]
            )
        ).rows[0]
    }

    async add_distinct_id(person: Person, distinct_id: string): Promise<void> {
        await this.pluginsServer.db.query(
            'INSERT INTO posthog_persondistinctid (distinct_id, person_id, team_id) VALUES ($1, $2, $3)',
            [distinct_id, person.id, person.team_id]
        )
    }

    create_event(
        event_uuid: UUID,
        event: string,
        team: Team,
        distinctId: string,
        properties?: Properties,
        timestamp?: DateTime | string,
        elements?: Element[]
    ): string {
        const timestampString = castTimestampOrNow(timestamp)
        const elementsChain = elements && elements.length ? elements_to_string(elements) : ''
        const eventUuidString = event_uuid.toString()

        const message = EventProto.create({
            uuid: eventUuidString,
            event,
            properties: JSON.stringify(properties ?? {}),
            timestamp: timestampString,
            teamId: team.id,
            distinctId,
            elementsChain,
            createdAt: timestampString,
        })

        this.kafkaProducerStreamEvent.write(EventProto.encode(message).finish())

        return eventUuidString
    }

    create_session_recording_event(
        uuid: UUID,
        team_id: number,
        distinct_id: string,
        session_id: string,
        timestamp: DateTime | string,
        snapshot_data: Record<any, any>
    ): string {
        const timestampString = castTimestampOrNow(timestamp)
        const uuidString = uuid.toString()

        const data = {
            uuid: uuidString,
            team_id: team_id,
            distinct_id: distinct_id,
            session_id: session_id,
            snapshot_data: JSON.stringify(snapshot_data),
            timestamp: timestampString,
            created_at: timestampString,
        }

        this.kafkaProducerStreamSessionRecording.write(Buffer.from(JSON.stringify(data)))

        return uuidString
    }
}
