import { PluginEvent } from '@posthog/plugin-scaffold'

import { Hub, PropertyOperator } from '../../../src/types'
import { createHub } from '../../../src/utils/db/hub'
import { ActionManager } from '../../../src/worker/ingestion/action-manager'
import { ActionMatcher } from '../../../src/worker/ingestion/action-matcher'
import { resetTestDatabase } from '../../helpers/sql'

function createEvent(index = 0): PluginEvent {
    return {
        distinct_id: 'my_id',
        ip: '127.0.0.1',
        site_url: 'http://localhost',
        team_id: 2,
        now: new Date().toISOString(),
        event: 'default event',
        properties: { key: 'value', index },
    }
}

describe('ActionManager', () => {
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

    it('returns the correct actions generally', async () => {
        const actionsMatched = await actionMatcher.match(createEvent())

        expect(actionsMatched).toEqual([])
    })
})
