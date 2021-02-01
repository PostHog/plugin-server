import { createProcessEventTests } from '../shared/process-event'

jest.setTimeout(600000) // 600 sec timeout

describe('process event (postgresql)', () => {
    createProcessEventTests('postgresql', {
        getSessionRecordingEvents: (server) => server.db.fetchSessionRecordingEvents(),
        getEvents: (server) => server.db.fetchEvents(),
        getPersons: (server) => server.db.fetchPersons(),
        getDistinctIds: (server, person) => server.db.fetchDistinctIdValues(person),
        getElements: (server, event) => server.db.fetchElements(event),
    })
})
