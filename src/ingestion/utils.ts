import { DateTime } from 'luxon'
import { Element, BaseEventMessage, RawEventMessage, EventMessage, BasePerson, RawPerson, Person } from '../types'

export function parseRawEventMessage(message: RawEventMessage): EventMessage {
    return {
        ...(message as BaseEventMessage),
        data: JSON.parse(message.data),
        now: DateTime.fromISO(message.now),
        sent_at: DateTime.fromISO(message.sent_at),
    }
}

export function parseRawPerson(rawPerson: RawPerson): Person {
    return { ...(rawPerson as BasePerson), created_at: DateTime.fromISO(rawPerson.created_at) }
}

export function unparsePersonPartial(person: Partial<Person>): Partial<RawPerson> {
    return { ...(person as BasePerson), ...(person.created_at ? { created_at: person.created_at.toISO() } : {}) }
}

export function escapeQuotes(input: string): string {
    return input.replace(/"/g, '\\"')
}

export function elementsToString(elements: Element[]): string {
    const ret = elements.map((element) => {
        let el_string = ''
        if (element.tag_name) {
            el_string += element.tag_name
        }
        if (element.attr_class) {
            element.attr_class.sort()
            for (const single_class of element.attr_class) {
                el_string += `.${single_class.replace(/"/g, '')}`
            }
        }
        let attributes: Record<string, any> = {
            ...(element.text ? { text: element.text } : {}),
            'nth-child': element.nth_child ?? 0,
            'nth-of-type': element.nth_of_type ?? 0,
            ...(element.href ? { href: element.href } : {}),
            ...(element.attr_id ? { attr_id: element.attr_id } : {}),
            ...element.attributes,
        }
        attributes = Object.fromEntries(
            Object.entries(attributes)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, value]) => [escapeQuotes(key.toString()), escapeQuotes(value.toString())])
        )
        el_string += ':'
        el_string += Object.entries(attributes)
            .map(([key, value]) => `${key}=${value}`)
            .join('')
        return el_string
    })
    return ret.join(';')
}

export function sanitizeEventName(eventName: any): string {
    if (typeof eventName !== 'string') {
        try {
            eventName = JSON.stringify(eventName)
        } catch {
            eventName = String(eventName)
        }
    }
    return eventName.substr(0, 200)
}
