import { Action,PluginsServerConfig } from '../../types'
import { DB } from '../../utils/db/db'
import { PubSub } from '../../utils/pubsub'
import { status } from '../../utils/status'

type ActionCache = Record<Action['id'], Action>

export class ActionManager {
    private ready: boolean
    private db: DB
    public pubSub: PubSub
    private actionCache: ActionCache

    constructor(db: DB, serverConfig: PluginsServerConfig) {
        this.ready = false
        this.db = db
        this.pubSub = new PubSub(serverConfig, {
            'fetch-action': async (message) => {
                const actionId = parseInt(message)
                const refetchedAction = await this.db.fetchAction(actionId)
                if (refetchedAction) {
                    status.info(
                        '🍿',
                        actionId in this.actionCache
                            ? `Refetched action ID ${actionId} from DB`
                            : `Fetched new action ID ${actionId} from DB`
                    )
                    this.actionCache[actionId] = refetchedAction
                } else if (actionId in this.actionCache) {
                    status.info(
                        '🍿',
                        `Tried to fetch action ID ${actionId} from DB, but it wasn't found in DB, so deleted from cache instead`
                    )
                    delete this.actionCache[actionId]
                } else {
                    status.info(
                        '🍿',
                        `Tried to fetch action ID ${actionId} from DB, but it wasn't found in DB or cache, so did nothing instead`
                    )
                }
            },
            'delete-action': (message) => {
                const actionId = parseInt(message)
                if (actionId in this.actionCache) {
                    status.info('🍿', `Deleted action ID ${actionId} from cache`)
                    delete this.actionCache[actionId]
                } else {
                    status.info(
                        '🍿',
                        `Tried to delete action ID ${actionId} from cache, but it wasn't found in cache, so did nothing instead`
                    )
                }
            },
        })
        this.actionCache = {}
    }

    public async prepare(): Promise<void> {
        this.actionCache = await this.db.fetchAllActionsMap()
        await this.pubSub.start()
        this.ready = true
    }

    public async close(): Promise<void> {
        await this.pubSub.stop()
    }

    public getAction(id: Action['id']): Action | undefined {
        if (!this.ready) {
            throw new Error('ActionManager is not ready! Run actionManager.prepare() before this')
        }
        return this.actionCache[id]
    }
}
