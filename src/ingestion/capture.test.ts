import { ingestionServer } from './server'
import request from 'supertest'

test('Rejects capture request with no data at all', async (done) => {
    const response = await request(ingestionServer).get('/')
    expect(response.body).toEqual({
        code: 'validation',
        message: 'No data found. Make sure to use a POST request when sending the payload in the body of the request.',
    })
    expect(response.status).toBe(400)
    done()
})

test('Disallows PATCH method', async (done) => {
    const response = await request(ingestionServer).patch('/')
    expect(response.body).toEqual({
        detail: `Method PATCH not allowed! Try GET or POST.`,
    })
    expect(response.status).toBe(405)
    done()
})

test('Disallows DELETE method', async (done) => {
    const response = await request(ingestionServer).delete('/')
    expect(response.body).toEqual({
        detail: `Method DELETE not allowed! Try GET or POST.`,
    })
    expect(response.status).toBe(405)
    done()
})
