import { DateTime } from 'luxon'
import { Element, BaseEventMessage, RawEventMessage, EventMessage, BasePerson, RawPerson, Person } from '../types'
import crypto from 'crypto'

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

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
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

// escape utf-8 characters into `\u1234`
function jsonEscapeUTF8(s: string): string {
    return s.replace(/[^\x20-\x7F]/g, (x) => '\\u' + ('000' + x.codePointAt(0)?.toString(16)).slice(-4))
}

// produce output compatible to that of python's json.dumps
function pythonDumps(obj: any): string {
    if (typeof obj === 'object' && obj !== null) {
        if (Array.isArray(obj)) {
            return `[${obj.map(pythonDumps).join(', ')}]` // space after comma
        } else {
            return `{${Object.keys(obj) // no space after '{' or before '}'
                .sort() // must sort the keys of the object!
                .map((k) => `${pythonDumps(k)}: ${pythonDumps(obj[k])}`) // space after ':'
                .join(', ')}}` // space after ','
        }
    } else if (typeof obj === 'string') {
        return jsonEscapeUTF8(JSON.stringify(obj))
    } else {
        return JSON.stringify(obj)
    }
}

export function hashElements(elements: Element[]): string {
    const elementsList = elements.map((element) => ({
        attributes: element.attributes ?? null,
        text: element.text ?? null,
        tag_name: element.tag_name ?? null,
        href: element.href ?? null,
        attr_id: element.attr_id ?? null,
        attr_class: element.attr_class ?? null,
        nth_child: element.nth_child ?? null,
        nth_of_type: element.nth_of_type ?? null,
        order: element.order ?? null,
    }))

    const serializedString = pythonDumps(elementsList)

    return crypto.createHash('md5').update(serializedString).digest('hex')
}
