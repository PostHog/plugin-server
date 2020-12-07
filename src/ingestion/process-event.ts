import { KafkaConsumer, LibrdKafkaError, Message, Producer, ProducerStream } from 'node-rdkafka'
import { DateTime, DateTimeOptions, Duration } from 'luxon'
import { loadSync } from 'protobufjs'
import { PluginsServer, Data, Properties, Element, Team, Event, Person } from 'types'
import { castTimestampOrNow, UUID, UUIDT } from './utils'
import { KAFKA_EVENTS, KAFKA_EVENTS_WAL, KAFKA_SESSION_RECORDING_EVENTS } from './topics'
import { elements_to_string } from './element'
import { join } from 'path'
import { runPlugins } from 'plugins'
import { PluginEvent } from 'posthog-plugins'

const root = loadSync(join(__dirname, 'idl/events.proto'))
const EventProto = root.lookupType('Event')

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
                // TODO: time with statsd
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

    handle_identify_or_alias(event: string, properties: Properties, distinct_id: string, team_id: number): void {
        if (event === '$create_alias') {
            /* TODO: 
            _alias(
                properties["alias"], distinct_id, team_id,
            )
            */
        } else if (event === '$identify') {
            if (properties['$anon_distinct_id']) {
                /* TODO:
                _alias(
                    properties["$anon_distinct_id"], distinct_id, team_id,
                )
                */
            }
            if (properties['$set']) {
                // TODO: _update_person_properties(team_id=team_id, distinct_id=distinct_id, properties=properties["$set"])
            }
            // TODO: _set_is_identified(team_id=team_id, distinct_id=distinct_id)
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
                    [sent_at ? sent_at.toISO() : DateTime.utc(), {}, team_id, null, false, person_uuid.toString()]
                )
                await this.pluginsServer.db.query(
                    'INSERT INTO posthog_persondistinctid (distinct_id, person_id, team_id) VALUES ($1, $2, $3)',
                    [distinct_id, personCreated.id, team_id]
                )
            } catch {}
        }

        this.create_event(event_uuid, event, team, distinct_id, properties, timestamp, elements_list)
    }

    create_event(
        event_uuid: UUID,
        event: string,
        team: Team,
        distinct_id: string,
        properties?: Properties,
        timestamp?: DateTime | string,
        elements?: Element[]
    ): string {
        const timestampString = castTimestampOrNow(timestamp)
        const elements_chain = elements && elements.length ? elements_to_string(elements) : ''
        const eventUuidString = event_uuid.toString()

        const message = EventProto.create({
            uuid: eventUuidString,
            event,
            properties: JSON.stringify(properties ?? {}),
            timestamp: timestampString,
            team_id: team.id,
            distinct_id,
            elements_chain,
            created_at: timestampString,
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
