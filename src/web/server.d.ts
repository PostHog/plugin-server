import { ParsedUrlQuery } from 'querystring'

declare module 'fastify' {
    export interface FastifyRequest {
        GET: ParsedUrlQuery
        POST: ParsedUrlQuery
    }
}
