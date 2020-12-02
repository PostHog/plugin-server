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

export function buildFastifyInstance(): FastifyInstance {
    const fastifyInstance = fastify()
    fastifyInstance.addHook('preHandler', async (request) => {
        // Mimic Django HttpRequest with GET and POST properties
        request.GET = urlParse(request.url, true).query
        try {
            request.POST = querystringParse(String(request.body))
        } catch {
            request.POST = {}
        }
    })
    fastifyInstance.all('*', getEvent)
    return fastifyInstance
}

export async function stopFastifyInstance(fastifyInstance: FastifyInstance): Promise<void> {
    await fastifyInstance.close()
    console.info(`\n🛑 Web server cleaned up!`)
}

export async function startWebServer(
    port: string | number = 3008,
    hostname?: string,
    withSignalHandling = true
): Promise<FastifyInstance> {
    console.info(`👾 Starting web server…`)
    const fastifyInstance = buildFastifyInstance()
    try {
        const address = await fastifyInstance.listen(port, hostname)
        console.info(`✅ Web server listening on ${address}!`)
    } catch (e) {
        console.error(`🛑 Web server could not start! ${e}`)
        return fastifyInstance
    }
    if (withSignalHandling) {
        // Free up port
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
            process.on(signal, () => stopFastifyInstance(fastifyInstance))
        }
    }
    return fastifyInstance
}
