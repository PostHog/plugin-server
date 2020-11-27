import { fastify, FastifyRequest, FastifyReply, FastifyInstance } from 'fastify'
import middie from 'middie'
import { parse as querystringParse } from 'querystring'
import { parse as urlParse } from 'url'

async function getEvent(request: FastifyRequest, reply: FastifyReply): Promise<Record<string, any>> {
    return {}
}

async function buildWebServer(): Promise<FastifyInstance> {
    const webServer = fastify()
    await webServer.register(middie)
    webServer.use((request: FastifyRequest, reply: FastifyReply, next: () => void) => {
        // Mimicking Django HttpRequest with GET and POST properties
        request.GET = urlParse(request.url, true).query
        try {
            request.POST = querystringParse(String(request.body))
        } catch {
            request.POST = {}
        }
        next()
    })
    return webServer
}

export async function startWebServer(
    port: string | number = 3008,
    hostname?: string,
    withSignalHandling = true
): Promise<[FastifyInstance, () => Promise<void>]> {
    console.info(`👾 Starting web server…`)
    const webServer = await buildWebServer()
    try {
        webServer.get('*', getEvent)
        webServer.post('*', getEvent)
        const address = await webServer.listen(port, hostname)
        console.info(`✅ Web server listening on ${address}!`)
    } catch (e) {
        console.error(`🛑 Web server could not start! ${e}`)
    }
    async function stopWebServer(): Promise<void> {
        await webServer.close()
        console.info(`\n🛑 Web server cleaned up!`)
    }
    if (withSignalHandling) {
        // Free up port
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
            process.on(signal, stopWebServer)
        }
    }
    return [webServer, stopWebServer]
}
