declare module 'fastify' {
    import { ParsedUrlQuery } from 'querystring'

    export interface FastifyRequest {
        GET: ParsedUrlQuery
        POST: ParsedUrlQuery
    }
}
