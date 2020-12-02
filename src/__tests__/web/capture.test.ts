import { buildFastifyInstance } from '../../web/server'
import * as request from 'supertest'

const fastifyInstance = buildFastifyInstance()
const { server } = fastifyInstance

beforeAll(fastifyInstance.ready)
afterAll(fastifyInstance.close)

test('Rejects capture request with no data at all', async () => {
    const response = await request(server).get('/')
    expect(response.body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: 'No data found. Make sure to use a POST request when sending the payload in the body of the request.',
    })
    expect(response.status).toBe(400)
})

test('Handles server errors', async () => {
    const response = await request(server).post('/').set('Content-Type', 'text/plain').send('1337')
    expect(response.body).toEqual({
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'Unexpected leet detected!',
    })
    expect(response.status).toBe(500)
})

test('Disallows PATCH method', async () => {
    const response = await request(server).patch('/')
    expect(response.body).toEqual({
        statusCode: 405,
        error: 'Method Not Allowed',
        message: `Method PATCH not allowed! Try GET or POST.`,
    })
    expect(response.status).toBe(405)
})

test('Disallows DELETE method', async () => {
    const response = await request(server).delete('/')
    expect(response.body).toEqual({
        statusCode: 405,
        error: 'Method Not Allowed',
        message: `Method DELETE not allowed! Try GET or POST.`,
    })
    expect(response.status).toBe(405)
})
