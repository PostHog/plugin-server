import { Properties } from '@posthog/plugin-scaffold'
import { ClickHouse } from 'clickhouse'
import { Producer } from 'kafkajs'
import { DateTime } from 'luxon'
import { Pool, QueryConfig, QueryResult, QueryResultRow } from 'pg'
import { KAFKA_PERSON, KAFKA_PERSON_UNIQUE_ID } from './ingestion/topics'
import { chainToElements, unparsePersonPartial } from './ingestion/utils'
import {
    Person,
    PersonDistinctId,
    RawPerson,
    RawOrganization,
    Team,
    PostgresSessionRecordingEvent,
    Event,
    ClickHouseEvent,
    Element,
} from './types'
import { castTimestampOrNow, clickHouseTimestampToISO, sanitizeSqlIdentifier } from './utils'

/** The recommended way of accessing the database. */
export class DB {
    /** Postgres connection pool for primary database access. */
    postgres: Pool
    /** Kafka producer used for syncing Postgres and ClickHouse person data. */
    kafkaProducer?: Producer
    /** ClickHouse used for syncing Postgres and ClickHouse person data. */
    clickhouse?: ClickHouse

    constructor(postgres: Pool, kafkaProducer?: Producer, clickhouse?: ClickHouse) {
        this.postgres = postgres
        this.kafkaProducer = kafkaProducer
        this.clickhouse = clickhouse
    }

    public async postgresQuery<R extends QueryResultRow = any, I extends any[] = any[]>(
        queryTextOrConfig: string | QueryConfig<I>,
        values?: I
    ): Promise<QueryResult<R>> {
        return this.postgres.query(queryTextOrConfig, values)
    }

    // Person

    public async fetchPersons(): Promise<Person[]> {
        const result = await this.postgresQuery('SELECT * FROM posthog_person')
        return result.rows as Person[]
    }

    public async fetchPerson(teamId: number, distinctId: string): Promise<Person | undefined> {
        const selectResult = await this.postgresQuery(
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
        if (selectResult.rows.length > 0) {
            const rawPerson: RawPerson = selectResult.rows[0]
            return { ...rawPerson, created_at: DateTime.fromISO(rawPerson.created_at) }
        }
    }

    public async createPerson(
        createdAt: DateTime,
        properties: Properties,
        teamId: number,
        isUserId: number | null,
        isIdentified: boolean,
        uuid: string,
        distinctIds?: string[]
    ): Promise<Person> {
        const insertResult = await this.postgresQuery(
            'INSERT INTO posthog_person (created_at, properties, team_id, is_user_id, is_identified, uuid) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [createdAt.toISO(), JSON.stringify(properties), teamId, isUserId, isIdentified, uuid]
        )
        const personCreated = insertResult.rows[0] as Person
        if (this.kafkaProducer) {
            const data = {
                created_at: castTimestampOrNow(createdAt),
                properties: JSON.stringify(properties),
                team_id: teamId,
                is_identified: isIdentified,
                id: uuid,
            }
            await this.kafkaProducer.send({
                topic: KAFKA_PERSON,
                messages: [{ value: Buffer.from(JSON.stringify(data)) }],
            })
        }

        for (const distinctId of distinctIds || []) {
            await this.addDistinctId(personCreated, distinctId)
        }

        return personCreated
    }

    public async updatePerson(person: Person, update: Partial<Person>): Promise<Person> {
        const updatedPerson: Person = { ...person, ...update }
        const values = [...Object.values(unparsePersonPartial(update)), person.id]
        await this.postgresQuery(
            `UPDATE posthog_person SET ${Object.keys(update).map(
                (field, index) => `"${sanitizeSqlIdentifier(field)}" = $${index + 1}`
            )} WHERE id = $${Object.values(update).length + 1}`,
            values
        )
        if (this.kafkaProducer) {
            const data = {
                created_at: castTimestampOrNow(updatedPerson.created_at),
                properties: JSON.stringify(updatedPerson.properties),
                team_id: updatedPerson.team_id,
                is_identified: updatedPerson.is_identified,
                id: updatedPerson.uuid.toString(),
            }
            await this.kafkaProducer.send({
                topic: KAFKA_PERSON,
                messages: [{ value: Buffer.from(JSON.stringify(data)) }],
            })
        }
        return updatedPerson
    }

    public async deletePerson(personId: number): Promise<void> {
        await this.postgresQuery('DELETE FROM posthog_persondistinctid WHERE person_id = $1', [personId])
        await this.postgresQuery('DELETE FROM posthog_person WHERE id = $1', [personId])
        if (this.clickhouse) {
            await this.clickhouse.query(`ALTER TABLE person DELETE WHERE id = ${personId}`).toPromise()
            await this.clickhouse
                .query(`ALTER TABLE person_distinct_id DELETE WHERE person_id = ${personId}`)
                .toPromise()
        }
    }

    // PersonDistinctId

    public async fetchDistinctIdValues(person: Person): Promise<string[]> {
        const result = await this.postgresQuery(
            'SELECT * FROM posthog_persondistinctid WHERE person_id=$1 and team_id=$2 ORDER BY id',
            [person.id, person.team_id]
        )
        return (result.rows as PersonDistinctId[]).map((pdi) => pdi.distinct_id)
    }

    public async addDistinctId(person: Person, distinctId: string): Promise<void> {
        const insertResult = await this.postgresQuery(
            'INSERT INTO posthog_persondistinctid (distinct_id, person_id, team_id) VALUES ($1, $2, $3) RETURNING *',
            [distinctId, person.id, person.team_id]
        )
        const personDistinctIdCreated = insertResult.rows[0] as PersonDistinctId
        if (this.kafkaProducer) {
            await this.kafkaProducer.send({
                topic: KAFKA_PERSON_UNIQUE_ID,
                messages: [{ value: Buffer.from(JSON.stringify(personDistinctIdCreated)) }],
            })
        }
    }

    public async updateDistinctId(
        personDistinctId: PersonDistinctId,
        update: Partial<PersonDistinctId>
    ): Promise<void> {
        const updatedPersonDistinctId: PersonDistinctId = { ...personDistinctId, ...update }
        await this.postgresQuery(
            `UPDATE posthog_persondistinctid SET ${Object.keys(update).map(
                (field, index) => `"${sanitizeSqlIdentifier(field)}" = $${index + 1}`
            )} WHERE id = $${Object.values(update).length + 1}`,
            [...Object.values(update), personDistinctId.id]
        )
        if (this.kafkaProducer) {
            await this.kafkaProducer.send({
                topic: KAFKA_PERSON_UNIQUE_ID,
                messages: [{ value: Buffer.from(JSON.stringify(updatedPersonDistinctId)) }],
            })
        }
    }

    // Organization

    public async fetchOrganization(organizationId: string): Promise<RawOrganization | undefined> {
        const selectResult = await this.postgresQuery(`SELECT * FROM posthog_organization WHERE id $1`, [
            organizationId,
        ])
        const rawOrganization: RawOrganization = selectResult.rows[0]
        return rawOrganization
    }

    // Event

    public async fetchEvents(): Promise<Event[] | ClickHouseEvent[]> {
        if (this.kafkaProducer) {
            const events = (await this.clickhouse?.query(`SELECT * FROM events`).toPromise()) as ClickHouseEvent[]
            return (
                events?.map(
                    (event) =>
                        ({
                            ...event,
                            ...(typeof event['properties'] === 'string'
                                ? { properties: JSON.parse(event.properties) }
                                : {}),
                            timestamp: clickHouseTimestampToISO(event.timestamp),
                        } as ClickHouseEvent)
                ) || []
            )
        } else {
            const result = await this.postgresQuery('SELECT * FROM posthog_event')
            return result.rows as Event[]
        }
    }

    // SessionRecordingEvent

    public async fetchSessionRecordingEvents(): Promise<PostgresSessionRecordingEvent[]> {
        const result = await this.postgresQuery('SELECT * FROM posthog_sessionrecordingevent')
        return result.rows as PostgresSessionRecordingEvent[]
    }

    // Element

    public async fetchElements(event: Event): Promise<Element[]> {
        if (this.kafkaProducer) {
            const events = (await this.clickhouse
                ?.query(`SELECT elements_chain FROM events WHERE uuid='${sanitizeSqlIdentifier((event as any).uuid)}'`)
                .toPromise()) as ClickHouseEvent[]
            const chain = events?.[0]?.elements_chain
            return chainToElements(chain)
        } else {
            return (await this.postgresQuery('SELECT * FROM posthog_element')).rows
        }
    }
}
