import { webServer } from './server'
import request from 'supertest'

test('Rejects capture request with no data at all', async (done) => {
    const response = await request(webServer).get('/')
    expect(response.body).toEqual({
        message: 'No data found. Make sure to use a POST request when sending the payload in the body of the request.',
    })
    expect(response.status).toBe(400)
    done()
})

test('Handles server errors', async (done) => {
    const response = await request(webServer).get('/').send('1337')
    expect(response.body).toEqual({
        message: 'An unexpected server error occurred!',
    })
    expect(response.status).toBe(500)
    done()
})

test('Disallows PATCH method', async (done) => {
    const response = await request(webServer).patch('/')
    expect(response.body).toEqual({
        message: `Method PATCH not allowed! Try GET or POST.`,
    })
    expect(response.status).toBe(405)
    done()
})

test('Disallows DELETE method', async (done) => {
    const response = await request(webServer).delete('/')
    expect(response.body).toEqual({
        message: `Method DELETE not allowed! Try GET or POST.`,
    })
    expect(response.status).toBe(405)
    done()
})
