import { PluginEvent } from '@posthog/plugin-scaffold'

import { Action, Team } from '../../types'
import { DB } from '../../utils/db/db'
import { status } from '../../utils/status'
import { delay } from '../../utils/utils'
import { ActionManager } from './action-manager'

export class ActionMatcher {
    private isReady: boolean
    private db: DB
    private actionManager: ActionManager

    // Exposed actionManager methods
    public reloadAllActions: typeof ActionManager.prototype.reloadAllActions
    public reloadAction: typeof ActionManager.prototype.reloadAction
    public dropAction: typeof ActionManager.prototype.dropAction

    constructor(db: DB) {
        this.isReady = false
        this.db = db
        this.actionManager = new ActionManager(db)
        this.reloadAllActions = this.actionManager.reloadAllActions
        this.reloadAction = this.actionManager.reloadAction
        this.dropAction = this.actionManager.dropAction
    }

    public async prepare(): Promise<void> {
        await this.actionManager.prepare()
        this.isReady = true
    }

    public async match(event: PluginEvent): Promise<Action[]> {
        await delay(10)
        return []
    }
}
