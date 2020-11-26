import { exception } from 'console'
import { createServer, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'http'
import { parse as parseQuerystring, ParsedUrlQuery } from 'querystring'
import { parse as parseUrl, UrlWithParsedQuery } from 'url'
import { getEvent } from './capture'

export interface JsonServerResponse extends ServerResponse {
    json: (
        this: JsonServerResponse,
        statusCode: number,
        responseData: any,
        headers?: OutgoingHttpHeaders
    ) => JsonServerResponse
}

export interface ServerRequest extends IncomingMessage {
    body: string
    parsedUrl: UrlWithParsedQuery
    GET: Record<string, string>
    POST: ParsedUrlQuery
}

function json(
    this: JsonServerResponse,
    statusCode: number,
    responseData: any,
    headers?: OutgoingHttpHeaders
): JsonServerResponse {
    this.writeHead(statusCode, {
        ...headers,
        'Content-Type': 'application/json',
    })
    this.end(JSON.stringify(responseData))
    return this
}

export const ingestionServer = createServer((request: IncomingMessage, response: ServerResponse) => {
    request.setEncoding('utf8')
    let body = ''
    request.on('data', (unicodeChunk: string) => {
        body += unicodeChunk
    })
    request.on('end', () => {
        // Mimicking Django HttpRequest with body, GET and POST properties
        const adjustedRequest = (request as unknown) as ServerRequest
        adjustedRequest.body = body
        adjustedRequest.parsedUrl = parseUrl(request.url!, true)
        adjustedRequest.GET = adjustedRequest.parsedUrl.query as Record<string, string>
        try {
            adjustedRequest.POST = parseQuerystring(body)
        } catch {
            adjustedRequest.POST = {}
        }
        // Mimicking Express Response with json method
        const adjustedResponse = (response as unknown) as JsonServerResponse
        adjustedResponse.json = json
        try {
            getEvent(adjustedRequest, adjustedResponse)
        } catch {
            adjustedResponse.json(500, {
                message: 'An unexpected server error occurred!',
            })
        }
    })
})

export function startIngestionServer(port = 3008, hostname = 'localhost', withSignalHandling = true): void {
    if (ingestionServer.listening) throw new Error('Ingestion server already is running!')
    ingestionServer.listen(port, hostname)
    console.info(`👾 Ingestion server listening on http://${hostname}:${port}!`)
    if (withSignalHandling) {
        // Free up port
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stopIngestionServer)
    }
}

export function stopIngestionServer(): void {
    if (!ingestionServer.listening) throw new Error('Ingestion server is not running!')
    ingestionServer.close()
    console.info(`🛑 Ingestion server closed!`)
}
