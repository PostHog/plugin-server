import { Hub, PropertyOperator } from '../../../src/types'
import { createHub } from '../../../src/utils/db/hub'
import { ActionManager } from '../../../src/worker/ingestion/action-manager'
import { resetTestDatabase } from '../../helpers/sql'

describe('ActionManager', () => {
    let hub: Hub
    let closeServer: () => Promise<void>
    let actionManager: ActionManager

    beforeEach(async () => {
        ;[hub, closeServer] = await createHub()
        await resetTestDatabase()
        actionManager = new ActionManager(hub.db)
        await actionManager.prepare()
    })
    afterEach(async () => {
        await closeServer()
    })

    it('returns the correct action', async () => {
        const action = actionManager.getAction(67)

        expect(action).toMatchObject({
            id: 67,
            name: 'Test Action',
            deleted: false,
            post_to_slack: false,
            slack_message_format: '',
            is_calculating: false,
            steps: [
                {
                    id: 911,
                    action_id: 67,
                    tag_name: null,
                    text: null,
                    href: null,
                    selector: null,
                    url: null,
                    url_matching: null,
                    name: null,
                    event: null,
                    properties: [{ type: 'event', operator: PropertyOperator.Exact, key: 'foo', value: ['bar'] }],
                },
            ],
        })

        await hub.db.postgresQuery(
            `UPDATE posthog_actionstep SET properties = jsonb_set(properties, '{0,key}', '"baz"') WHERE id = 911`,
            undefined,
            'testKey'
        )

        // This is normally dispatched by Django and broadcasted by Piscina
        await actionManager.reloadAction(67)
        const reloadedAction = actionManager.getAction(67)

        expect(reloadedAction).toMatchObject({
            id: 67,
            name: 'Test Action',
            deleted: false,
            post_to_slack: false,
            slack_message_format: '',
            is_calculating: false,
            steps: [
                {
                    id: 911,
                    action_id: 67,
                    tag_name: null,
                    text: null,
                    href: null,
                    selector: null,
                    url: null,
                    url_matching: null,
                    name: null,
                    event: null,
                    properties: [{ type: 'event', operator: PropertyOperator.Exact, key: 'baz', value: ['bar'] }],
                },
            ],
        })
    })

    it('returns the correct action when reloaded via Piscina', async () => {
        const action = actionManager.getAction(67)

        expect(action).toMatchObject({
            id: 67,
            name: 'Test Action',
            deleted: false,
            post_to_slack: false,
            slack_message_format: '',
            is_calculating: false,
            steps: [
                {
                    id: 911,
                    action_id: 67,
                    tag_name: null,
                    text: null,
                    href: null,
                    selector: null,
                    url: null,
                    url_matching: null,
                    name: null,
                    event: null,
                    properties: [{ type: 'event', operator: PropertyOperator.Exact, key: 'foo', value: ['bar'] }],
                },
            ],
        })

        await hub.db.postgresQuery(
            `UPDATE posthog_actionstep SET properties = jsonb_set(properties, '{0,key}', '"baz"') WHERE id = 911`,
            undefined,
            'testKey'
        )

        // This is normally dispatched by Django and broadcasted by Piscina
        await actionManager.reloadAction(67)
        const reloadedAction = actionManager.getAction(67)

        expect(reloadedAction).toMatchObject({
            id: 67,
            name: 'Test Action',
            deleted: false,
            post_to_slack: false,
            slack_message_format: '',
            is_calculating: false,
            steps: [
                {
                    id: 911,
                    action_id: 67,
                    tag_name: null,
                    text: null,
                    href: null,
                    selector: null,
                    url: null,
                    url_matching: null,
                    name: null,
                    event: null,
                    properties: [{ type: 'event', operator: PropertyOperator.Exact, key: 'baz', value: ['bar'] }],
                },
            ],
        })
    })
})
