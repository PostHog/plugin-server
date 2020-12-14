import { KafkaConsumer, Producer, ProducerStream } from '@posthog/node-rdkafka'
import { DateTime } from 'luxon'
import { PluginsServer, EventData, Properties, Queue } from 'types'
import { UUIDT } from '../utils'
import { KAFKA_EVENTS, KAFKA_SESSION_RECORDING_EVENTS } from './topics'
import { Pool } from 'pg'

export class EventsProcessor implements Queue {
    pluginsServer: PluginsServer
    db: Pool
    kafkaConsumer: KafkaConsumer

    constructor(pluginsServer: PluginsServer) {
        if (!pluginsServer.KAFKA_HOSTS) {
            throw new Error('You must set KAFKA_HOSTS to process events from Kafka!')
        }
        this.pluginsServer = pluginsServer
        this.db = pluginsServer.db
        this.kafkaConsumer = new KafkaConsumer(
            {
                'group.id': 'plugin-ingestion',
                'metadata.broker.list': this.pluginsServer.KAFKA_HOSTS!,
            },
            {
                'auto.offset.reset': 'earliest',
            }
        ).on('disconnected', () => {
            console.info(`🛑 Kafka consumer disconnected!`)
        })
    }

    start(): void {
        console.info(`⏬ Connecting Kafka consumer to ${this.pluginsServer.KAFKA_HOSTS}...`)
        this.kafkaConsumer.connect()
    }

    stop(): void {
        console.info(`⏳ Stopping event processing...`)
        this.kafkaConsumer.disconnect()
    }

    async process_event_ee(
        distinct_id: string,
        ip: string,
        site_url: string,
        data: EventData,
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

        console.info('EE ingestion not operational yet, discarded event')

        /* TODO: unlock in next PR
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
        */
    }
}
