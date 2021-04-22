import * as fetch from 'node-fetch'
import { nodePostHog } from 'posthog-js-lite/dist/src/targets/node'

export const posthog = nodePostHog('sTMFPsFhdP1Ssg', {
    fetch,
    apiHost: 'https://app.posthog.com',
})

if (process.env.NODE_ENV === 'test') {
    posthog.optOut()
}
