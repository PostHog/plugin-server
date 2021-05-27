import { PluginEvent } from '@posthog/plugin-scaffold'
import escapeStringRegexp from 'escape-string-regexp'

import { Action, ActionStep, ActionStepUrlMatching, Team } from '../../types'
import { DB } from '../../utils/db/db'
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

    /** Prepare ActionMatcher instance for matching by ensuring action data is loaded. */
    public async prepare(): Promise<void> {
        await this.actionManager.prepare()
        this.isReady = true
    }

    /** Get all actions matched to the event. */
    public async match(event: PluginEvent): Promise<Action[]> {
        await delay(10) // TODO: DELETE!
        const teamActions: Action[] = Object.values(this.actionManager.getTeamActions(event.team_id))
        const matches: Action[] = teamActions.filter((action) => this.checkAction(event, action))
        return matches
    }

    /**
     * Base level of action matching.
     *
     * Return whether the event is a match for the action.
     * The event is considered a match if any of the action's steps (match groups) is a match.
     */
    public checkAction(event: PluginEvent, action: Action): boolean {
        return action.steps.some((step) => this.checkStep(event, step))
    }

    /**
     * Sublevel 1 of action matching.
     *
     * Return whether the event is a match for the step (match group).
     * The event is considered a match if no subcheck fails. Many subchecks are usually irrelevant and skipped.
     */
    private checkStep(event: PluginEvent, step: ActionStep): boolean {
        // TODO: reorganize into single return
        if (!this.checkStepElement(event, step)) {
            // tag_name, text, href
            return false
        }
        // if (!this.checkStepSelector(event, step)) {
        //     // selector
        //     return false
        // }
        if (!this.checkStepUrl(event, step)) {
            // url, url_matching
            return false
        }
        // if (!this.checkStepName(event, step)) {
        //     // name – is this event relevant???
        //     return false
        // }
        if (!this.checkStepEvent(event, step)) {
            // event
            return false
        }
        // if (!this.checkStepFilters(event, step)) {
        //     // properties
        //     return false
        // }
        return true
    }

    /**
     * Sublevel 2 of action matching.
     *
     * Return whether the event is a match for the step's "URL" constraint.
     */
    private checkStepUrl(event: PluginEvent, step: ActionStep): boolean {
        // CHECK CONDITIONS
        if (step.url_matching || step.url) {
            if (!(step.url_matching && step.url)) {
                throw new Error(`Both OR neither of ActionStep.url_matching and ActionStep.url must be set!`)
            }
            const url = event.properties?.$current_url
            if (!url || typeof url !== 'string') {
                return false // URL IS UNKNOWN
            }
            let isUrlOk: boolean
            switch (step.url_matching) {
                case ActionStepUrlMatching.Contains:
                    // Simulating SQL LIKE behavior (_ = any single character, % = any zero or more characters)
                    const adjustedRegExpString = escapeStringRegexp(step.url).replace(/_/g, '.').replace(/%/g, '.*')
                    isUrlOk = new RegExp(`.*${adjustedRegExpString}.*`).test(url)
                    break
                case ActionStepUrlMatching.Regex:
                    isUrlOk = new RegExp(step.url).test(url)
                    break
                case ActionStepUrlMatching.Exact:
                    isUrlOk = step.url === url
                    break
                default:
                    throw new Error(`Unrecognized ActionStep.url_matching value ${step.url_matching}!`)
            }
            if (!isUrlOk) {
                return false // URL IS A MISMATCH
            }
        }
        return true
    }

    /**
     * Sublevel 2 of action matching.
     *
     * Return whether the event is a match for
     * the step's "Link href equals", "Text equals" and "HTML selector matches" constraints.
     */
    private checkStepElement(event: PluginEvent, step: ActionStep): boolean {
        // CHECK CONDITIONS
        if (step.href || step.text || step.href) {
            const elements: Record<string, any>[] | undefined = event.properties?.['$elements']
            if (elements?.length) {
                return elements.some((el) => {
                    // Synced with EventsProcessor
                    const text = el['$el_text']?.slice(0, 400)
                    const tag_name = el['tag_name']
                    const href = el['attr__href']?.slice(0, 2048)
                    if (step.href && href !== step.href) {
                        return false // ELEMENT HREF IS A MISMATCH
                    }
                    if (step.tag_name && tag_name !== step.tag_name) {
                        return false // ELEMENT TAG NAME IS A MISMATCH
                    }
                    if (step.text && text !== step.text) {
                        return false // ELEMENT TEXT IS A MISATCH
                    }
                    return true
                }) // AT LEAST ONE ELEMENT MUST BE A SUBMATCH
            }
            return false // NO MATCH CAN BE MADE SINCE THERE ARE NO ELEMENTS
        }
        return true
    }

    /**
     * Sublevel 2 of action matching.
     *
     * Return whether the event is a match for the step's event name constraint.
     */
    private checkStepEvent(event: PluginEvent, step: ActionStep): boolean {
        // CHECK CONDITIONS
        if (step.event && event.event !== step.event) {
            return false // EVENT NAME IS A MISMATCH
        }
        return true
    }
}
