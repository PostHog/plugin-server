import { fastify, FastifyRequest, FastifyReply, FastifyInstance } from 'fastify'
import middie from 'middie'
import { parse as querystringParse, ParsedUrlQuery } from 'querystring'
import { parse as urlParse } from 'url'
import { getEvent } from './capture'

declare module 'fastify' {
    export interface FastifyRequest {
        GET: ParsedUrlQuery
        POST: ParsedUrlQuery
    }
}

export function buildWebServer(): FastifyInstance {
    const webServer = fastify()
    webServer.addHook('preHandler', (request, reply, done) => {
        // Mimicking Django HttpRequest with GET and POST properties
        request.GET = urlParse(request.url, true).query
        try {
            request.POST = querystringParse(String(request.body))
        } catch {
            request.POST = {}
        }
        done()
    })
    webServer.all('*', getEvent)
    return webServer
}

export const webServer = buildWebServer()

export async function stopWebServer(webServerToStop: FastifyInstance = webServer): Promise<void> {
    await webServerToStop.close()
    console.info(`\n🛑 Web server cleaned up!`)
}

export async function startWebServer(
    port: string | number = 3008,
    hostname?: string,
    withSignalHandling = true
): Promise<FastifyInstance> {
    console.info(`👾 Starting web server…`)
    try {
        const address = await webServer.listen(port, hostname)
        console.info(`✅ Web server listening on ${address}!`)
    } catch (e) {
        console.error(`🛑 Web server could not start! ${e}`)
    }
    if (withSignalHandling) {
        // Free up port
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
            process.on(signal, () => stopWebServer(webServer))
        }
    }
    return webServer
}
