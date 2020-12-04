import { Element } from 'types'

function _escape(input: string): string {
    return input.replace(/"/g, '\\"')
}

export function elements_to_string(elements: Element[]): string {
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
                .map(([key, value]) => [_escape(key.toString()), _escape(value.toString())])
        )
        el_string += ':'
        el_string += Object.entries(attributes)
            .map(([key, value]) => `${key}=${value}`)
            .join('')
        return el_string
    })
    return ret.join(';')
}
