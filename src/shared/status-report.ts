import * as Sentry from '@sentry/node'
import * as schedule from 'node-schedule'
import { TeamId } from 'types'

import { posthog } from './posthog'

class StatusReport {
    timeSpentRunningPluginsPerTeam: Record<TeamId, number>
    statusReportJob: schedule.Job
    statusReportJobConfigured: boolean

    constructor() {
        this.timeSpentRunningPluginsPerTeam = {} as Record<TeamId, number>
        this.statusReportJob = {} as schedule.Job
        this.statusReportJobConfigured = false
    }

    private captureStatusReport() {
        for (const [teamId, totalPluginsDuration] of Object.entries(this.timeSpentRunningPluginsPerTeam)) {
            posthog.capture('$plugin_running_duration', {
                team: teamId,
                time_ms: totalPluginsDuration,
                time_seconds: Math.round(totalPluginsDuration / 10) / 1000,
            })
        }
        this.timeSpentRunningPluginsPerTeam = {} as Record<TeamId, number>
    }

    public addToTimeSpentRunningPlugins(teamId: number, increment: number) {
        if (teamId in this.timeSpentRunningPluginsPerTeam) {
            this.timeSpentRunningPluginsPerTeam[teamId] += increment
            return
        }
        this.timeSpentRunningPluginsPerTeam[teamId] = increment
    }

    public startStatusReportSchedule() {
        if (this.statusReportJobConfigured) {
            return
        }
        try {
            this.statusReportJob = schedule.scheduleJob('0 * * * *', () => {
                this.captureStatusReport()
            })
            this.statusReportJobConfigured = true
        } catch (err) {
            Sentry.captureException(err, { tags: { plugin_seconds_report: '1' } })
        }
    }

    public stopStatusReportSchedule() {
        this.captureStatusReport()
        posthog.flush()
        this.statusReportJob.cancel()
    }
}

export const statusReport = new StatusReport()
