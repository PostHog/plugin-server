import { readFileSync } from 'fs'

export const { version } = JSON.parse(readFileSync('../package.json').toString())
