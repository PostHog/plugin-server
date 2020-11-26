import { decode } from 'js-base64'
import { gunzipSync } from 'zlib'
import { ServerRequest } from './server'

export function loadDataFromRequest(request: ServerRequest): any {
    const dataRes: Record<string, any> = { data: {}, body: null }
    let data: any
    if (request.method === 'POST') {
        if (request.headers['content-type'] === 'application/json') {
            data = request.body
            try {
                dataRes['body'] = { ...JSON.parse(request.body) }
            } catch {}
        } else {
            try {
                data = request.POST['data']
            } catch {}
        }
    } else {
        data = request.GET['data']
    }

    if (isLooselyFalsy(data)) return {}

    // TODO: convert below from Python
    // # add the data in sentry's scope in case there's an exception
    // with push_scope() as scope:
    //     scope.set_context("data", data)

    let compression = request.GET['compression'] || request.POST['compression'] || request.headers['content-encoding']
    if (Array.isArray(compression)) compression = compression[0]
    compression = compression && compression.toLowerCase()

    switch (compression) {
        case 'gzip':
            data = gunzipSync(data)
            break
        case 'lz64':
            // TODO: convert below from Python
            // data = lzstring.LZString().decompressFromBase64(typeof data === 'string' ? data.replace(" ", "+") : data.decode().replace(" ", "+")).encode("utf-16", "surrogatepass").decode("utf-16")
            break
        default:
            break
    }

    // Is it plain json?
    try {
        data = JSON.parse(data)
    } catch {
        // if not, it's probably base64 encoded from other libraries
        data = base64ToJson(data)
    }
    dataRes['data'] = data
    // FIXME: data can also be an array, function assumes it's either None or a dictionary.
    return dataRes
}

export function base64ToJson(data: string): any {
    return JSON.parse(
        decode(data.replace(' ', '+') + '===')
        // TODO: investigate UTF-8/UTF-16 surrogate passes here
    )
}

export function isLooselyFalsy(value: any): boolean {
    return Array.isArray(value) ? !value.length : !value || !Object.keys(value).length
}
