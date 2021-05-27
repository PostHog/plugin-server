import { PluginEvent } from '@posthog/plugin-scaffold'

import { Action, ActionStepUrlMatching, Hub, PropertyOperator } from '../../../src/types'
import { createHub } from '../../../src/utils/db/hub'
import { ActionMatcher } from '../../../src/worker/ingestion/action-matcher'
import { resetTestDatabase } from '../../helpers/sql'

describe('ActionMatcher', () => {
    let hub: Hub
    let closeServer: () => Promise<void>
    let actionMatcher: ActionMatcher

    beforeEach(async () => {
        ;[hub, closeServer] = await createHub()
        await resetTestDatabase()
        actionMatcher = new ActionMatcher(hub.db)
        await actionMatcher.prepare()
    })

    afterEach(async () => {
        await closeServer()
    })

    const TEAM_ID = 2
    const ACTION_ID = 69
    const ACTION_STEP_ID = 913

    it('returns no match if action has no steps', () => {
        const event: PluginEvent = {
            distinct_id: 'my_id',
            ip: '127.0.0.1',
            site_url: 'http://localhost',
            team_id: 2,
            now: new Date().toISOString(),
            event: 'default event',
            properties: { key: 'value' },
        }

        const actionDefinition: Action = {
            id: 1,
            team_id: 2,
            name: 'Test',
            created_at: new Date().toISOString(),
            created_by_id: 999,
            deleted: false,
            post_to_slack: false,
            slack_message_format: '',
            is_calculating: false,
            updated_at: new Date().toISOString(),
            last_calculated_at: new Date().toISOString(),
            steps: [],
        }

        expect(actionMatcher.checkAction(event, actionDefinition)).toBeFalsy()
    })

    it('returns a match in case of URL contains page view', () => {
        const eventPosthog: PluginEvent = {
            distinct_id: 'my_id',
            ip: '127.0.0.1',
            site_url: 'http://localhost',
            team_id: 2,
            now: new Date().toISOString(),
            event: '$pageview',
            properties: { $current_url: 'http://posthog.com/pricing' },
        }
        const eventExample: PluginEvent = {
            distinct_id: 'my_id',
            ip: '127.0.0.1',
            site_url: 'http://localhost',
            team_id: 2,
            now: new Date().toISOString(),
            event: '$pageview',
            properties: { $current_url: 'https://example.com/' },
        }

        const actionDefinition: Action = {
            id: 1,
            team_id: 2,
            name: 'Test',
            created_at: new Date().toISOString(),
            created_by_id: 999,
            deleted: false,
            post_to_slack: false,
            slack_message_format: '',
            is_calculating: false,
            updated_at: new Date().toISOString(),
            last_calculated_at: new Date().toISOString(),
            steps: [
                {
                    id: 5,
                    action_id: 1,
                    tag_name: null,
                    text: null,
                    href: null,
                    selector: null,
                    url: 'example.com',
                    url_matching: ActionStepUrlMatching.Contains,
                    name: null,
                    event: '$pageview',
                    properties: null,
                },
            ],
        }

        expect(actionMatcher.checkAction(eventPosthog, actionDefinition)).toBeFalsy()
        expect(actionMatcher.checkAction(eventExample, actionDefinition)).toBeTruthy()
    })
})
