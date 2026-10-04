import { ApiError, type DashboardApi } from './client'
import type { Alert, AlertNotification, GraphResponse } from './types'
import graphFixture from '../mocks/graph.json'
import { buildMockData } from '../mocks/mockData'

type State = ReturnType<typeof buildMockData> & { graph: GraphResponse }

const fresh = (): State => ({
  ...buildMockData(),
  graph: structuredClone(graphFixture) as unknown as GraphResponse,
})

let state = fresh()
let offline = false

const findAlert = (id: string) => state.alerts.find((a) => a.id === id)

// Approval queues one voice call; the mock then walks it through the states the Alerts agent
// reports so polling shows the whole outcome.
function queueCall(alert: Alert) {
  const notification: AlertNotification = {
    notification_id: `notification_${alert.id}_${alert.notifications.length + 1}`,
    channel: 'voice',
    status: 'queued',
    attempt_count: 0,
    last_error: null,
  }
  alert.notifications.push(notification)
  const advance = (patch: Partial<AlertNotification>, ms: number) =>
    setTimeout(() => {
      const current = findAlert(alert.id)?.notifications.find((n) => n.notification_id === notification.notification_id)
      if (current) Object.assign(current, patch)
    }, ms)
  advance({ status: 'sending', attempt_count: 1 }, 3000)
  advance({ status: 'accepted' }, 7000)
  advance({ status: 'delivered' }, 15000)
}

// Controls for development and for recording the demo.
export const mockControls = {
  setOffline: (value: boolean) => { offline = value },
  isOffline: () => offline,
  // Simulates a second operator approving first, to see the 409 message:
  // run mockControls.reviewAsAnotherOperator('alert_demo_01') in the console, then click Approve
  // before the next poll (5 s).
  reviewAsAnotherOperator: (id: string) => {
    const alert = findAlert(id)
    if (!alert || alert.status !== 'pending_review') return false
    alert.version += 1
    alert.status = 'queued'
    alert.approved_by = 'operator.other'
    alert.approved_at = new Date().toISOString()
    alert.review_reason = 'Preventive alert reviewed'
    queueCall(alert)
    return true
  },
}

if (import.meta.env.DEV) Object.assign(window, { mockControls })

async function respond<T>(fn: () => T, ms = 250): Promise<T> {
  await new Promise((r) => setTimeout(r, ms))
  if (offline) throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server.', true)
  return structuredClone(fn())
}

const page = <T,>(items: T[]) => ({ items, next_cursor: null })

export const mockAdapter: DashboardApi = {
  getGraph: (threatCode) =>
    respond(() => {
      if (threatCode !== state.graph.threat_code) return { ...state.graph, nodes: [], edges: [] }
      return state.graph
    }),

  getTimeline: (plotId) => respond(() => page(state.timeline[plotId] ?? [])),

  getAlerts: (status) =>
    respond(() => page(status ? state.alerts.filter((a) => a.status === status) : state.alerts)),

  getAlert: (id) =>
    respond(() => {
      const alert = findAlert(id)
      if (!alert) throw new ApiError(404, 'NOT_FOUND', 'Alert not found.')
      return alert
    }),

  // Same rules and error codes as backend/app/alerts.py review_alert.
  reviewAlert: (id, body) =>
    respond(() => {
      const alert = findAlert(id)
      if (!alert) throw new ApiError(404, 'NOT_FOUND', 'Alert not found.')
      if (alert.status !== 'pending_review') {
        throw new ApiError(409, 'ALERT_ALREADY_REVIEWED', `The alert is already ${alert.status}.`)
      }
      if (alert.version !== body.expected_version) {
        throw new ApiError(409, 'VERSION_CONFLICT', 'The alert changed; reload and try again.')
      }
      alert.version += 1
      alert.review_reason = body.reason || null
      alert.approved_by = 'operator.demo'
      alert.approved_at = new Date().toISOString()
      if (body.decision === 'reject') {
        alert.status = 'rejected'
        return alert
      }
      // approved -> queued, with the call queued in the same step (section 10.7).
      alert.message = body.message
      alert.status = 'queued'
      queueCall(alert)
      return alert
    }, 500),

  getFollowups: () => respond(() => page(state.followups)),

  getResolvedCases: (plotId) =>
    respond(() => page(plotId ? state.resolved.filter((r) => r.plot_id === plotId) : state.resolved)),

  resetDemo: () =>
    respond(() => {
      state = fresh()
    }),
}
