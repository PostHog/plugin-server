import { PluginEvent } from '@posthog/plugin-scaffold'
import { DateTime, Duration } from 'luxon'
import { PluginsServer, EventData, Properties, Element, Team, Person, PersonDistinctId, CohortPeople } from 'types'
import { castTimestampOrNow, UUID, UUIDT } from '../utils'
import { elementsToString } from './element'
import { Event as EventProto } from '../idl/protos'
import { Pool } from 'pg'
import { Producer } from 'kafkajs'
import { KAFKA_EVENTS, KAFKA_SESSION_RECORDING_EVENTS } from './topics'

export class EventsProcessor {
    pluginsServer: PluginsServer
    db: Pool
    kafkaProducer: Producer

    constructor(pluginsServer: PluginsServer) {
        this.pluginsServer = pluginsServer
        this.db = pluginsServer.db
        this.kafkaProducer = pluginsServer.kafkaProducer!
    }

    public async processEventEE(
        distinctId: string,
        ip: string,
        siteUrl: string,
        data: PluginEvent,
        teamId: number,
        now: DateTime,
        sentAt: DateTime | null,
        eventUuid: UUID
    ): Promise<void> {
        const properties: Properties = data.properties ?? {}
        if (data['$set']) {
            properties['$set'] = data['$set']
        }

        const personUuid = new UUIDT()

        const ts = this.handleTimestamp(data, now, sentAt)
        this.handleIdentifyOrAlias(data['event'], properties, distinctId, teamId)

        if (data['event'] === '$snapshot') {
            await this.createSessionRecordingEvent(
                eventUuid,
                teamId,
                distinctId,
                properties['$session_id'],
                ts,
                properties['$snapshot_data']
            )
        } else {
            await this.captureEE(
                eventUuid,
                personUuid,
                ip,
                siteUrl,
                teamId,
                data['event'],
                distinctId,
                properties,
                ts,
                sentAt
            )
        }
    }

    private handleTimestamp(data: EventData, now: DateTime, sentAt: DateTime | null): DateTime {
        if (data['timestamp']) {
            if (sentAt) {
                // sent_at - timestamp == now - x
                // x = now + (timestamp - sent_at)
                try {
                    // timestamp and sent_at must both be in the same format: either both with or both without timezones
                    // otherwise we can't get a diff to add to now
                    return now.plus(DateTime.fromISO(data['timestamp']).diff(sentAt))
                } catch (error) {
                    console.error(error)
                }
            }
            return DateTime.fromISO(data['timestamp'])
        }
        if (data['offset']) {
            return now.minus(Duration.fromMillis(data['offset']))
        }
        return now
    }

    private async handleIdentifyOrAlias(
        event: string,
        properties: Properties,
        distinctId: string,
        teamId: number
    ): Promise<void> {
        if (event === '$create_alias') {
            await this.alias(properties['alias'], distinctId, teamId)
        } else if (event === '$identify') {
            if (properties['$anon_distinct_id']) {
                await this.alias(properties['$anon_distinct_id'], distinctId, teamId)
            }
            if (properties['$set']) {
                this.updatePersonProperties(teamId, distinctId, properties['$set'])
            }
            this.setIsIdentified(teamId, distinctId)
        }
    }

    private async setIsIdentified(teamId: number, distinctId: string, isIdentified = true): Promise<void> {
        let personFound = await this.fetchPerson(teamId, distinctId)
        if (!personFound) {
            try {
                const personCreated = await this.createPerson(DateTime.utc(), {}, teamId, null, true, new UUIDT())
                this.addDistinctId(personCreated, distinctId)
            } catch {
                // Catch race condition where in between getting and creating,
                // another request already created this person
                personFound = await this.fetchPerson(teamId, distinctId)
            }
        }
        if (personFound && !personFound.is_identified) {
            await this.db.query('UPDATE posthog_person SET is_identified = $1 WHERE id = $2', [
                isIdentified,
                personFound.id,
            ])
        }
    }

    private async updatePersonProperties(teamId: number, distinctId: string, properties: Properties): Promise<void> {
        let personFound = await this.fetchPerson(teamId, distinctId)
        if (!personFound) {
            try {
                const personCreated = await this.createPerson(
                    DateTime.utc(),
                    properties,
                    teamId,
                    null,
                    false,
                    new UUIDT()
                )
                await this.addDistinctId(personCreated, distinctId)
            } catch {
                // Catch race condition where in between getting and creating,
                // another request already created this person
                personFound = await this.fetchPerson(teamId, distinctId)
            }
        }
        if (personFound) {
            this.db.query('UPDATE posthog_person SET properties = $1 WHERE id = $2', [
                { ...personFound.properties, ...properties },
                personFound.id,
            ])
        }
    }

    private async alias(
        previousDistinctId: string,
        distinctId: string,
        teamId: number,
        retryIfFailed = true
    ): Promise<void> {
        const oldPerson = await this.fetchPerson(teamId, previousDistinctId)
        const newPerson = await this.fetchPerson(teamId, distinctId)

        if (oldPerson && !newPerson) {
            try {
                this.addDistinctId(oldPerson, distinctId)
                // Catch race case when somebody already added this distinct_id between .get and .addDistinctId
            } catch {
                // integrity error
                if (retryIfFailed) {
                    // run everything again to merge the users if needed
                    this.alias(previousDistinctId, distinctId, teamId, false)
                }
            }
            return
        }

        if (!oldPerson && newPerson) {
            try {
                this.addDistinctId(newPerson, previousDistinctId)
                // Catch race case when somebody already added this distinct_id between .get and .addDistinctId
            } catch {
                // integrity error
                if (retryIfFailed) {
                    // run everything again to merge the users if needed
                    this.alias(previousDistinctId, distinctId, teamId, false)
                }
            }
            return
        }

        if (!oldPerson && !newPerson) {
            try {
                const personCreated = await this.createPerson(DateTime.utc(), {}, teamId, null, false, new UUIDT())
                this.addDistinctId(personCreated, distinctId)
                this.addDistinctId(personCreated, previousDistinctId)
            } catch {
                // Catch race condition where in between getting and creating,
                // another request already created this person
                if (retryIfFailed) {
                    // Try once more, probably one of the two persons exists now
                    this.alias(previousDistinctId, distinctId, teamId, false)
                }
            }
            return
        }

        if (oldPerson && newPerson && oldPerson.id !== newPerson.id) {
            this.mergePeople(newPerson, [oldPerson])
        }
    }

    private async mergePeople(mergeInto: Person, peopleToMerge: Person[]): Promise<void> {
        let first_seen = mergeInto.created_at

        // merge the properties
        for (const other_person of peopleToMerge) {
            mergeInto.properties = { ...other_person.properties, ...mergeInto.properties }
            if (other_person.created_at < first_seen) {
                // Keep the oldest created_at (i.e. the first time we've seen this person)
                first_seen = other_person.created_at
            }
        }

        await this.db.query('UPDATE posthog_person SET created_at = $1 WHERE id = $2', [
            first_seen.toISO(),
            mergeInto.id,
        ])

        // merge the distinct_ids
        for (const other_person of peopleToMerge) {
            const other_person_distinct_ids: PersonDistinctId[] = (
                await this.db.query('SELECT * FROM posthog_persondistinctid WHERE person_id = $1 AND team_id = $2', [
                    other_person,
                    mergeInto.team_id,
                ])
            ).rows
            for (const person_distinct_id of other_person_distinct_ids) {
                await this.db.query('UPDATE posthog_persondistinctid SET person_id = $1 WHERE id = $2', [
                    mergeInto.id,
                    person_distinct_id.id,
                ])
            }

            const other_person_cohort_ids: CohortPeople[] = (
                await this.db.query('SELECT * FROM posthog_cohortpeople WHERE person_id = $1', [other_person.id])
            ).rows
            for (const person_cohort_id of other_person_cohort_ids) {
                await this.db.query('UPDATE posthog_cohortpeople SET person_id = $1 WHERE id = $2', [
                    mergeInto.id,
                    person_cohort_id.id,
                ])
            }

            await this.db.query('DELETE FROM posthog_person WHERE id = $1', [other_person.id])
        }
    }

    private async captureEE(
        eventUuid: UUID,
        personUuid: UUID,
        ip: string,
        siteUrl: string,
        teamId: number,
        event: string,
        distinctId: string,
        properties: Properties,
        timestamp: DateTime,
        sentAt: DateTime | null
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

        const team: Team = (await this.db.query('SELECT * FROM posthog_team WHERE id = $1', [teamId])).rows[0]

        if (!team.anonymize_ips && !('$ip' in properties)) {
            properties['$ip'] = ip
        }

        this.storeNamesAndProperties(team, event, properties)

        const pdiSelectResult = await this.db.query(
            'SELECT COUNT(*) AS pdicount FROM posthog_persondistinctid WHERE team_id = $1 AND distinct_id = $2',
            [teamId, distinctId]
        )
        const pdiCount = parseInt(pdiSelectResult.rows[0].pdicount)

        if (!pdiCount) {
            // Catch race condition where in between getting and creating, another request already created this user
            try {
                const personCreated: Person = await this.createPerson(
                    sentAt || DateTime.utc(),
                    {},
                    teamId,
                    null,
                    false,
                    personUuid.toString()
                )
                await this.addDistinctId(personCreated, distinctId)
            } catch {}
        }

        await this.createEvent(eventUuid, event, team, distinctId, properties, timestamp, elements_list)
    }

    private async storeNamesAndProperties(team: Team, event: string, properties: Properties): Promise<void> {
        // In _capture we only prefetch a couple of fields in Team to avoid fetching too much data
        let save = false
        if (!team.ingested_event) {
            // First event for the team captured
            // TODO: capture "first team event ingested"
            team.ingested_event = true
            save = true
        }
        if (team.event_names && !(event in team.event_names)) {
            save = true
            team.event_names.push(event)
            team.event_names_with_usage.push({ event: event, usage_count: null, volume: null })
        }
        for (const [key, value] of Object.entries(properties)) {
            if (team.event_properties && !(key in team.event_properties)) {
                team.event_properties.push(key)
                team.event_properties_with_usage.push({ key: key, usage_count: null, volume: null })
                save = true
            }
            if (
                typeof value === 'number' &&
                team.event_properties_numerical &&
                !(key in team.event_properties_numerical)
            ) {
                team.event_properties_numerical.push(key)
                save = true
            }
        }
        if (save) {
            await this.db.query(
                `UPDATE posthog_team SET
                    ingested_event = $1, event_names = $2, event_names_with_usage = $3, event_properties = $4,
                    event_properties_with_usage = $5, event_properties_numerical = $6
                WHERE id = $7`,
                [
                    team.ingested_event,
                    JSON.stringify(team.event_names),
                    JSON.stringify(team.event_names_with_usage),
                    JSON.stringify(team.event_properties),
                    JSON.stringify(team.event_names_with_usage),
                    JSON.stringify(team.event_properties_numerical),
                    team.id,
                ]
            )
        }
    }

    private async fetchPerson(teamId: number, distinctId: string): Promise<Person | undefined> {
        const selectResult = await this.db.query(
            `SELECT
                posthog_person.id, posthog_person.created_at, posthog_person.team_id, posthog_person.properties,
                posthog_person.is_user_id, posthog_person.is_identified, posthog_person.uuid,
                posthog_persondistinctid.team_id AS persondistinctid__team_id,
                posthog_persondistinctid.distinct_id AS persondistinctid__distinct_id
            FROM posthog_person
            JOIN posthog_persondistinctid ON (posthog_persondistinctid.person_id = posthog_person.id)
            WHERE
                posthog_person.team_id = $1
                AND posthog_persondistinctid.team_id = $1
                AND posthog_persondistinctid.distinct_id = $2`,
            [teamId, distinctId]
        )
        return selectResult.rows[0]
    }

    private async createPerson(
        createdAt: DateTime,
        properties: Properties,
        teamId: number,
        isUserId: number | null,
        isIdentified: boolean,
        uuid: UUID | string
    ): Promise<Person> {
        const insertResult = await this.db.query(
            'INSERT INTO posthog_person (created_at, properties, team_id, is_user_id, is_identified, uuid) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [createdAt.toISO(), properties, teamId, isUserId, isIdentified, uuid.toString()]
        )
        return insertResult.rows[0]
    }

    private async addDistinctId(person: Person, distinctId: string): Promise<void> {
        await this.db.query(
            'INSERT INTO posthog_persondistinctid (distinct_id, person_id, team_id) VALUES ($1, $2, $3) RETURNING *',
            [distinctId, person.id, person.team_id]
        )
    }

    private async createEvent(
        event_uuid: UUID,
        event: string,
        team: Team,
        distinctId: string,
        properties?: Properties,
        timestamp?: DateTime | string,
        elements?: Element[]
    ): Promise<string> {
        const timestampString = castTimestampOrNow(timestamp)
        const elementsChain = elements && elements.length ? elementsToString(elements) : ''
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

        await this.kafkaProducer.send({
            topic: KAFKA_EVENTS,
            messages: [{ key: eventUuidString, value: EventProto.encodeDelimited(message).finish() as Buffer }],
        })

        return eventUuidString
    }

    private async createSessionRecordingEvent(
        eventUuid: UUID,
        team_id: number,
        distinct_id: string,
        session_id: string,
        timestamp: DateTime | string,
        snapshot_data: Record<any, any>
    ): Promise<string> {
        const timestampString = castTimestampOrNow(timestamp)
        const eventUuidString = eventUuid.toString()

        const data = {
            uuid: eventUuidString,
            team_id: team_id,
            distinct_id: distinct_id,
            session_id: session_id,
            snapshot_data: JSON.stringify(snapshot_data),
            timestamp: timestampString,
            created_at: timestampString,
        }

        await this.kafkaProducer.send({
            topic: KAFKA_SESSION_RECORDING_EVENTS,
            messages: [{ key: eventUuidString, value: Buffer.from(JSON.stringify(data)) }],
        })

        return eventUuidString
    }
}
