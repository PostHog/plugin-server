import { mocked } from 'ts-jest/utils'

import { createServer } from '../../../src/shared/server'
import { UUIDT } from '../../../src/shared/utils'
import { PluginsServer } from '../../../src/types'
import { TeamManager } from '../../../src/worker/ingestion/team-manager'
import { resetTestDatabase } from '../../helpers/sql'

describe('TeamManager()', () => {
    let server: PluginsServer
    let closeServer: () => Promise<void>
    let teamManager: TeamManager

    beforeEach(async () => {
        ;[server, closeServer] = await createServer()
        await resetTestDatabase()
        teamManager = new TeamManager(server.db)
    })
    afterEach(async () => {
        await closeServer()
    })

    describe('fetchTeam()', () => {
        it('fetches and caches the team', async () => {
            jest.spyOn(global.Date, 'now').mockImplementation(() => new Date('2020-02-27 11:00:05').getTime())
            jest.spyOn(server.db, 'postgresQuery')

            let team = await teamManager.fetchTeam(2)
            expect(team!.name).toEqual('TEST PROJECT')
            // expect(team!.__fetch_event_uuid).toEqual('uuid1')

            jest.spyOn(global.Date, 'now').mockImplementation(() => new Date('2020-02-27 11:00:25').getTime())
            await server.db.postgresQuery("UPDATE posthog_team SET name = 'Updated Name!'")

            mocked(server.db.postgresQuery).mockClear()

            team = await teamManager.fetchTeam(2)
            expect(team!.name).toEqual('TEST PROJECT')
            // expect(team!.__fetch_event_uuid).toEqual('uuid1')
            expect(server.db.postgresQuery).toHaveBeenCalledTimes(0)

            jest.spyOn(global.Date, 'now').mockImplementation(() => new Date('2020-02-27 11:00:36').getTime())

            team = await teamManager.fetchTeam(2)
            expect(team!.name).toEqual('Updated Name!')
            // expect(team!.__fetch_event_uuid).toEqual('uuid3')

            expect(server.db.postgresQuery).toHaveBeenCalledTimes(1)
        })

        it('returns null when no such team', async () => {
            expect(await teamManager.fetchTeam(-1)).toEqual(null)
        })
    })

    describe('shouldSendWebhooks()', () => {
        it('returns false if unknown team', async () => {
            expect(await teamManager.shouldSendWebhooks(-1)).toEqual(false)
        })

        it('returns false if no hooks set up and team.slack_incoming_webhook == false', async () => {
            expect(await teamManager.shouldSendWebhooks(2)).toEqual(false)
        })

        it('returns true if hooks are set up', async () => {
            await server.db.postgresQuery('UPDATE posthog_team SET slack_incoming_webhook = true')
            await server.db.postgresQuery(
                "INSERT INTO ee_hook (id, team_id, user_id, event, target, created, updated) VALUES('test_hook', 2, 1001, 'action_performed', 'http://example.com', now(), now())"
            )

            expect(await teamManager.shouldSendWebhooks(2)).toEqual(true)
        })

        it('caches results, webhooks-only case', async () => {
            jest.spyOn(global.Date, 'now').mockImplementation(() => new Date('2020-02-27 11:00:05').getTime())
            jest.spyOn(server.db, 'postgresQuery')

            expect(await teamManager.shouldSendWebhooks(2)).toEqual(false)

            await server.db.postgresQuery("UPDATE posthog_team SET slack_incoming_webhook = 'https://x.com/'")
            mocked(server.db.postgresQuery).mockClear()

            jest.spyOn(global.Date, 'now').mockImplementation(() => new Date('2020-02-27 11:00:10').getTime())
            expect(await teamManager.shouldSendWebhooks(2)).toEqual(false)
            expect(server.db.postgresQuery).toHaveBeenCalledTimes(0)

            jest.spyOn(global.Date, 'now').mockImplementation(() => new Date('2020-02-27 11:00:45').getTime())
            expect(await teamManager.shouldSendWebhooks(2)).toEqual(true)
            expect(server.db.postgresQuery).toHaveBeenCalledTimes(1)
        })

        it('caches results, Zapier hooks-only case', async () => {
            jest.spyOn(global.Date, 'now').mockImplementation(() => new Date('2020-02-27 11:00:05').getTime())
            jest.spyOn(server.db, 'postgresQuery')

            expect(await teamManager.shouldSendWebhooks(2)).toEqual(false)

            await server.db.postgresQuery(
                "INSERT INTO ee_hook (id, team_id, user_id, event, target, created, updated) VALUES('test_hook', 2, 1001, 'action_performed', 'http://example.com', now(), now())"
            )
            mocked(server.db.postgresQuery).mockClear()

            jest.spyOn(global.Date, 'now').mockImplementation(() => new Date('2020-02-27 11:00:10').getTime())
            expect(await teamManager.shouldSendWebhooks(2)).toEqual(false)
            expect(server.db.postgresQuery).toHaveBeenCalledTimes(0)

            jest.spyOn(global.Date, 'now').mockImplementation(() => new Date('2020-02-27 11:00:45').getTime())
            expect(await teamManager.shouldSendWebhooks(2)).toEqual(true)
            expect(server.db.postgresQuery).toHaveBeenCalledTimes(2)
        })
    })

    describe('updateEventNamesAndProperties()', () => {
        let posthog: any

        beforeEach(async () => {
            posthog = { capture: jest.fn(), identify: jest.fn() }
            await server.db.postgresQuery("UPDATE posthog_team SET ingested_event = 't'")
            await server.db.postgresQuery('DELETE FROM posthog_eventdefinition')
            await server.db.postgresQuery('DELETE FROM posthog_propertydefinition')
            await server.db.postgresQuery(
                `INSERT INTO posthog_eventdefinition (id, name, volume_30_day, query_usage_30_day, team_id) VALUES ($1, $2, $3, $4, $5)`,
                [new UUIDT().toString(), '$pageview', 3, 2, 2]
            )
            await server.db.postgresQuery(
                `INSERT INTO posthog_propertydefinition (id, name, is_numerical, volume_30_day, query_usage_30_day, team_id) VALUES ($1, $2, $3, $4, $5, $6)`,
                [new UUIDT().toString(), 'property_name', false, null, null, 2]
            )
            await server.db.postgresQuery(
                `INSERT INTO posthog_propertydefinition (id, name, is_numerical, volume_30_day, query_usage_30_day, team_id) VALUES ($1, $2, $3, $4, $5, $6)`,
                [new UUIDT().toString(), 'numeric_prop', true, null, null, 2]
            )
        })

        it('updates event properties', async () => {
            await teamManager.updateEventNamesAndProperties(
                2,
                'new-event',
                '',
                { property_name: 'efg', number: 4, numeric_prop: 5 },
                posthog
            )
            teamManager.teamCache.clear()

            const team = await teamManager.fetchTeam(2)
            // expect(team?.event_names).toEqual(['$pageview', 'new-event'])
            // expect(team?.event_names_with_usage).toEqual([
            //     { event: '$pageview', usage_count: 2, volume: 3 },
            //     { event: 'new-event', usage_count: null, volume: null },
            // ])
            // expect(team?.event_properties).toEqual(['property_name', 'numeric_prop', 'number'])
            // expect(team?.event_properties_with_usage).toEqual([
            //     { key: 'property_name', usage_count: null, volume: null },
            //     { key: 'numeric_prop', usage_count: null, volume: null },
            //     { key: 'number', usage_count: null, volume: null },
            // ])
            // expect(team?.event_properties_numerical).toEqual(['numeric_prop', 'number'])
        })

        it('does not update anything if nothing changes', async () => {
            await teamManager.fetchTeam(2)
            await teamManager.cacheEventNamesAndProperties(2)
            jest.spyOn(server.db, 'postgresQuery')

            await teamManager.updateEventNamesAndProperties(2, '$pageview', '', {}, posthog)

            expect(server.db.postgresQuery).not.toHaveBeenCalled()
        })

        it('does not capture event', async () => {
            await teamManager.updateEventNamesAndProperties(
                2,
                'new-event',
                '',
                { property_name: 'efg', number: 4 },
                posthog
            )

            expect(posthog.identify).not.toHaveBeenCalled()
            expect(posthog.capture).not.toHaveBeenCalled()
        })

        it('handles cache invalidation properly', async () => {
            await teamManager.fetchTeam(2)
            await teamManager.cacheEventNamesAndProperties(2)
            await server.db.postgresQuery('UPDATE posthog_team SET event_names = $1', [
                JSON.stringify(['$pageview', '$foobar']),
            ])

            jest.spyOn(teamManager, 'fetchTeam')
            jest.spyOn(server.db, 'postgresQuery')

            // Scenario: Different request comes in, team gets reloaded in the background with no updates
            await teamManager.updateEventNamesAndProperties(2, '$foobar', 'uuid2', {}, posthog)
            expect(teamManager.fetchTeam).toHaveBeenCalledTimes(2)
            expect(server.db.postgresQuery).toHaveBeenCalledTimes(1)

            // Scenario: Next request but a real update
            mocked(teamManager.fetchTeam).mockClear()
            mocked(server.db.postgresQuery).mockClear()

            await teamManager.updateEventNamesAndProperties(2, '$newevent', 'uuid2', {}, posthog)
            expect(teamManager.fetchTeam).toHaveBeenCalledTimes(1)
            expect(server.db.postgresQuery).toHaveBeenCalledTimes(1)
        })

        describe('first event has not yet been ingested', () => {
            beforeEach(async () => {
                await server.db.postgresQuery('UPDATE posthog_team SET ingested_event = false')
            })

            it('calls posthog.identify and posthog.capture', async () => {
                await teamManager.updateEventNamesAndProperties(2, 'new-event', '', {}, posthog)

                const team = await teamManager.fetchTeam(2)
                expect(posthog.identify).toHaveBeenCalledWith('plugin_test_user_distinct_id_1001')
                expect(posthog.capture).toHaveBeenCalledWith('first team event ingested', { team: team!.uuid })
            })
        })
    })
})
