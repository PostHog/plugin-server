import * as fetch from 'node-fetch'
import { nodePostHog } from 'posthog-js-lite/dist/src/targets/node'

import { defaultConfig } from './config'

const posthog = nodePostHog(defaultConfig.POSTHOG_PROJECT_API_KEY, { fetch })

export { posthog }
