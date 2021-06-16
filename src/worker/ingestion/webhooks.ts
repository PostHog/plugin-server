import { PluginEvent } from '@posthog/plugin-scaffold'
import fetch from 'node-fetch'
import { format } from 'util'

import { Action, Person } from '../../types'

export enum WebhookType {
    Slack = 'slack',
    Discord = 'discord',
    Teams = 'teams',
}

function determineWebhookType(url: string): WebhookType {
    if (url.toLowerCase().includes('slack.com')) {
        return WebhookType.Slack
    }
    if (url.toLowerCase().includes('discord.com')) {
        return WebhookType.Discord
    }
    return WebhookType.Teams
}

function getUserDetails(
    event: PluginEvent,
    person: Person,
    siteUrl: string,
    webhookType: WebhookType
): [string, string] {
    const userName = person.properties['email'] || event.distinct_id
    let userMarkdown: string
    if (webhookType === WebhookType.Slack) {
        userMarkdown = `<${siteUrl}/person/${event.distinct_id}|${userName}>`
    } else {
        userMarkdown = `[${userName}](${siteUrl}/person/${event.distinct_id})`
    }
    return [userName, userMarkdown]
}

function getActionDetails(
    action: Action,
    event: PluginEvent,
    siteUrl: string,
    webhookType: WebhookType
): [string, string] {
    let actionMarkdown: string
    if (webhookType === WebhookType.Slack) {
        actionMarkdown = `<${siteUrl}/action/${action.id}|${action.name}>`
    } else {
        actionMarkdown = `[${action.name}](${siteUrl}/action/${action.id})`
    }
    return [String(action.name), actionMarkdown]
}

function getTokens(messageFormat: string): [string[], string] {
    const matchedTokens = messageFormat.match(/(?<=\[)(.*?)(?=\])/g) || []
    let tokenizedMessage = messageFormat
    if (matchedTokens.length) {
        tokenizedMessage = tokenizedMessage.replace(/\[(.*?)\]/g, '%s')
    }
    return [matchedTokens, tokenizedMessage]
}

function getValueOfToken(
    action: Action,
    event: PluginEvent,
    person: Person | undefined,
    siteUrl: string,
    webhookType: WebhookType,
    tokenParts: string[]
): [string, string] {
    let text = ''
    let markdown = ''

    if (tokenParts[0] === 'user') {
        if (tokenParts[1] == 'name') {
            ;[text, markdown] = person
                ? getUserDetails(event, person, siteUrl, webhookType)
                : ['undefined', 'undefined']
        } else {
            const propertyName = `$${tokenParts[1]}`
            if (event.properties && propertyName in event.properties) {
                const property = event.properties[propertyName]
                text = typeof property === 'string' ? property : JSON.stringify(property)
            } else {
                text = 'undefined'
            }
            markdown = text
        }
    } else if (tokenParts[0] === 'action') {
        if (tokenParts[1] == 'name') {
            ;[text, markdown] = getActionDetails(action, event, siteUrl, webhookType)
        }
    } else if (tokenParts[0] == 'event') {
        if (tokenParts[1] == 'name') {
            text = markdown = event.event
        } else if (tokenParts[1] == 'properties' && tokenParts.length > 2) {
            const propertyName = tokenParts[2]
            if (event.properties && propertyName in event.properties) {
                const property = event.properties[propertyName]
                text = typeof property === 'string' ? property : JSON.stringify(property)
            } else {
                text = 'undefined'
            }
            markdown = text
        }
    } else {
        throw new Error()
    }
    return [text, markdown]
}

function getFormattedMessage(
    action: Action,
    event: PluginEvent,
    person: Person | undefined,
    siteUrl: string,
    webhookType: WebhookType
): [string, string] {
    const messageFormat = action.slack_message_format || '[action.name] was triggered by [user.name]'
    let messageText: string
    let messageMarkdown: string

    try {
        const [tokens, tokenizedMessage] = getTokens(messageFormat)
        const values: string[] = []
        const markdownValues: string[] = []

        for (const token of tokens) {
            const tokenParts = token.match(/\w+/g) || []

            const [value, markdownValue] = getValueOfToken(action, event, person, siteUrl, webhookType, tokenParts)
            values.push(value)
            markdownValues.push(markdownValue)
        }
        messageText = format(tokenizedMessage, ...values)
        messageMarkdown = format(tokenizedMessage, ...markdownValues)
    } catch (error) {
        const [actionName, actionMarkdown] = getActionDetails(action, event, siteUrl, webhookType)
        messageText = `⚠ Error: There are one or more formatting errors in the message template for action "${actionName}".`
        messageMarkdown = `*⚠ Error: There are one or more formatting errors in the message template for action "${actionMarkdown}".*`
    }

    return [messageText, messageMarkdown]
}

export async function postEventToWebhook(
    webhookUrl: string,
    action: Action,
    event: PluginEvent,
    person: Person | undefined,
    siteUrl: string
): Promise<void> {
    const webhookType = determineWebhookType(webhookUrl)
    const [messageText, messageMarkdown] = getFormattedMessage(action, event, person, siteUrl, webhookType)
    let message: Record<string, any>
    if (webhookType === WebhookType.Slack) {
        message = {
            text: messageText,
            blocks: [{ type: 'section', text: { type: 'mrkdwn', text: messageMarkdown } }],
        }
    } else {
        message = {
            text: messageMarkdown,
        }
    }
    await fetch(webhookUrl, {
        method: 'POST',
        body: JSON.stringify(message),
        headers: { 'Content-Type': 'application/json' },
    })
}
