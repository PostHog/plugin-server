import Piscina from 'piscina'
import { isMainThread } from 'worker_threads'

export const piscina: Piscina = (null as any) as Piscina

if (isMainThread) {
    module.exports = { piscina: new Piscina({ filename: __filename }) }
} else {
    console.log('🧵 Starting Piscina Worker Thread')
    module.exports = ({ task, args }: { task: string; args: any[] }): any => {
        if (task === 'hello') {
            return `hello ${args[0]}!`
        }
    }
}
