import { PluginEvent } from '@posthog/plugin-scaffold'

import { Action, Person } from '../../../src/types'
import {
    determineWebhookType,
    getActionDetails,
    getFormattedMessage,
    getTokens,
    getUserDetails,
    getValueOfToken,
    WebhookType,
} from '../../../src/worker/ingestion/hooks'

describe('determineWebhookType', () => {
    test('Slack', () => {
        const webhookType = determineWebhookType('https://hooks.slack.com/services/')

        expect(webhookType).toBe(WebhookType.Slack)
    })

    test('Discord', () => {
        const webhookType = determineWebhookType('https://discord.com/api/webhooks/')

        expect(webhookType).toBe(WebhookType.Discord)
    })

    test('Teams', () => {
        const webhookType = determineWebhookType('https://outlook.office.com/webhook/')

        expect(webhookType).toBe(WebhookType.Teams)
    })
})

describe('getUserDetails', () => {
    test('Slack', () => {
        const [userDetails, userDetailsMarkdown] = getUserDetails(
            { distinct_id: 2 } as unknown as PluginEvent,
            { properties: { email: 'test@posthog.com' } } as unknown as Person,
            'http://localhost:8000',
            WebhookType.Slack
        )

        expect(userDetails).toBe('test@posthog.com')
        expect(userDetailsMarkdown).toBe('<http://localhost:8000/person/2|test@posthog.com>')
    })

    test('Teams', () => {
        const [userDetails, userDetailsMarkdown] = getUserDetails(
            { distinct_id: 2 } as unknown as PluginEvent,
            { properties: { email: 'test@posthog.com' } } as unknown as Person,
            'http://localhost:8000',
            WebhookType.Teams
        )

        expect(userDetails).toBe('test@posthog.com')
        expect(userDetailsMarkdown).toBe('[test@posthog.com](http://localhost:8000/person/2)')
    })
})

describe('getActionDetails', () => {
    test('Slack', () => {
        const [actionDetails, actionDetailsMarkdown] = getActionDetails(
            { id: 1, name: 'action1' } as Action,
            { distinct_id: 2 } as unknown as PluginEvent,
            'http://localhost:8000',
            WebhookType.Slack
        )

        expect(actionDetails).toBe('action1')
        expect(actionDetailsMarkdown).toBe('<http://localhost:8000/action/1|action1>')
    })

    test('Teams', () => {
        const [actionDetails, actionDetailsMarkdown] = getActionDetails(
            { id: 1, name: 'action1' } as Action,
            { distinct_id: 2 } as unknown as PluginEvent,
            'http://localhost:8000',
            WebhookType.Teams
        )

        expect(actionDetails).toBe('action1')
        expect(actionDetailsMarkdown).toBe('[action1](http://localhost:8000/action/1)')
    })
})

/*
    def test_get_tokens_well_formatted(self) -> None:
        format1 = "[action.name] got did by [user.name]"
        matched_tokens, tokenised_message = get_tokens(format1)
        self.assertEqual(matched_tokens, ["action.name", "user.name"])
        self.assertEqual(tokenised_message, "{} got did by {}")

    def test_get_value_of_token_user_correct(self) -> None:
        self.team.slack_incoming_webhook = "https://hooks.slack.com/services/"
        event1 = Event.objects.create(team=self.team, distinct_id="2", properties={"$browser": "Chrome"})
        action1 = Action.objects.create(team=self.team, name="action1", id=1)

        token_user_name = ["user", "name"]
        text, markdown = get_value_of_token(action1, event1, "http://localhost:8000", token_user_name)
        self.assertEqual(text, "2")
        # markdown output is already tested in test_get_user_details

        token_user_prop = ["user", "browser"]
        text, markdown = get_value_of_token(action1, event1, "http://localhost:8000", token_user_prop)
        self.assertEqual(text, "Chrome")

    def test_get_value_of_token_user_incorrect(self) -> None:
        self.team.slack_incoming_webhook = "https://hooks.slack.com/services/"
        event1 = Event.objects.create(team=self.team, distinct_id="2", properties={"$browser": "Chrome"})
        action1 = Action.objects.create(team=self.team, name="action1", id=1)

        token_user_noprop = ["user", "notaproperty"]
        text, markdown = get_value_of_token(action1, event1, "http://localhost:8000", token_user_noprop)
        self.assertEqual(text, "undefined")

    def test_get_formatted_message(self) -> None:
        self.team.slack_incoming_webhook = "https://hooks.slack.com/services/"
        event1 = Event.objects.create(
            team=self.team, distinct_id="2", properties={"$browser": "Chrome", "page_title": "Pricing"}
        )
        action1 = Action.objects.create(
            team=self.team,
            name="action1",
            id=1,
            slack_message_format="[user.name] from [user.browser] on [event.properties.page_title] page with [event.properties.fruit]",
        )

        text, markdown = get_formatted_message(action1, event1, "https://localhost:8000")
        self.assertEqual(text, "2 from Chrome on Pricing page with undefined")

    def test_get_formatted_message_default(self) -> None:
        """
        If slack_message_format is empty, use the default message format.
        [action] was triggered by [user]
        """
        self.team.slack_incoming_webhook = "https://hooks.slack.com/services/"
        event1 = Event.objects.create(team=self.team, distinct_id="2", properties={"$browser": "Chrome"})
        action1 = Action.objects.create(team=self.team, name="action1", id=1, slack_message_format="")
        text, markdown = get_formatted_message(action1, event1, "https://localhost:8000")
        self.assertEqual(text, "action1 was triggered by 2")

    def test_get_formatted_message_incorrect(self) -> None:
        self.team.slack_incoming_webhook = "https://hooks.slack.com/services/"
        event1 = Event.objects.create(team=self.team, distinct_id="2", properties={"$browser": "Chrome"})
        action1 = Action.objects.create(
            team=self.team,
            name="action1",
            id=1,
            slack_message_format="[user.name] did thing from browser [user.bbbrowzer]",
        )
        text, markdown = get_formatted_message(action1, event1, "https://localhost:8000")
        self.assertIn("undefined", text)
*/
