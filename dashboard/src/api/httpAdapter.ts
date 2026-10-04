import { ALERT_STATUS, FOLLOWUP_STATUS, deliveryLabel } from '../lib/labels'
import { ApiError, type DashboardApi } from './client'
import type {
  Alert, AlertNotification, AlertReview, AlertStatus, ApiErrorBody, DataUsed, FollowUp, FollowUpStatus, GraphResponse,
  Page, Recommendation, ResolvedCase, ResolvedMention, TimelineEntry, Verification,
} from './types'

const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8000/v1'

// Section 17: three call attempts before the SMS. The backend doesn't expose it in the list.
const FOLLOWUP_CALL_ATTEMPTS = 3

type RequestOptions = { method?: string; body?: unknown; idempotencyKey?: string }

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey

  let res: Response
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server.', true)
  }

  if (!res.ok) {
    let body: ApiErrorBody | null = null
    try {
      body = (await res.json()) as ApiErrorBody
    } catch {
      body = null
    }
    throw new ApiError(
      res.status,
      body?.error.code ?? `HTTP_${res.status}`,
      body?.error.message ?? res.statusText,
      body?.error.retryable ?? res.status >= 500,
    )
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

const qs = (params: Record<string, string | undefined>) => {
  const entries = Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined)
  return entries.length ? `?${new URLSearchParams(entries).toString()}` : ''
}

const page = <T>(items: T[]): Page<T> => ({ items, next_cursor: null })

// ---------------------------------------------------------------------------
// Shapes the backend returns (contracts/models.py). Screens use the types in
// ./types; the to* functions translate so components don't change.
// ---------------------------------------------------------------------------

interface ApiAlert {
  alert_id: string
  plot_id: string
  plot_label: string
  recipient_label: string
  threat_code: string
  status: AlertStatus
  version: number
  message: string | null
  inspection_priority: Alert['inspection_priority']
  reasons: string[]
  risk_evaluation_id: string
  created_at: string
  review_reason: string | null
  approved_by: string | null
  approved_at: string | null
  notifications: AlertNotification[]
  is_demo: boolean
}

interface ApiFollowup {
  followup_id: string
  case_id: string
  plot_id: string
  due_at: string
  status: FollowUpStatus
  channel: 'voice' | 'sms'
  attempt_count: number
  case_summary: { symptoms: string[]; guidance_given: string | null }
  is_demo: boolean
  // It also carries `contact` with the phone (communications uses it); dropped here.
}

interface ApiResolution {
  resolution_id: string
  case_id: string
  plot_id: string
  plot_label: string
  threat_code: string
  symptoms: string[]
  resolved_at: string
  solution_statement: string | null
  solution_codes: string[] | null
  matches_protocol: boolean | null
  outcome: ResolvedCase['outcome']
  verification: Verification
  is_demo: boolean
}

interface ApiReport {
  report_id: string
  channel: 'voice' | 'sms'
  received_at: string
  symptoms: string[]
  user_statement: string
}

interface ApiAssessment {
  assessment_id: string
  created_at: string
  disposition: 'ask_more' | 'advise' | 'refer'
  suspected_issue: { label: string } | null
  data_used: DataUsed[]
  resolved_case_mentions: ResolvedMention[]
  recommendations: Recommendation[]
  human_review_required: boolean
}

const DISPOSITION_TITLE: Record<ApiAssessment['disposition'], string> = {
  ask_more: 'The advisor asked for more information',
  advise: 'The advisor gave guidance',
  refer: 'The advisor referred to an agronomist',
}

function toAlert(a: ApiAlert): Alert {
  return {
    id: a.alert_id,
    plot_id: a.plot_id,
    plot_label: a.plot_label,
    recipient_label: a.recipient_label,
    threat_code: a.threat_code,
    risk_evaluation_id: a.risk_evaluation_id,
    inspection_priority: a.inspection_priority,
    status: a.status,
    message: a.message ?? '',
    reasons: a.reasons,
    version: a.version,
    created_at: a.created_at,
    approved_by: a.approved_by,
    approved_at: a.approved_at,
    review_reason: a.review_reason,
    notifications: a.notifications,
    is_demo: a.is_demo,
  }
}

function caseSummary(s: ApiFollowup['case_summary']): string {
  const parts = []
  if (s.symptoms.length) parts.push(`Symptoms: ${s.symptoms.join(', ')}`)
  if (s.guidance_given) parts.push(`Guidance given: ${s.guidance_given}`)
  return parts.join(' · ') || 'No case summary'
}

function toFollowup(f: ApiFollowup, labels: Map<string, string>): FollowUp {
  return {
    id: f.followup_id,
    case_id: f.case_id,
    plot_id: f.plot_id,
    plot_label: labels.get(f.plot_id) ?? f.plot_id,
    due_at: f.due_at,
    status: f.status,
    channel: f.channel,
    attempt_count: f.attempt_count,
    max_attempts: FOLLOWUP_CALL_ATTEMPTS,
    case_summary: caseSummary(f.case_summary),
    // The farmer's answer lives in the follow-up report, not in the list.
    status_reported: null,
    actions_taken: null,
    is_demo: f.is_demo,
  }
}

function toResolved(r: ApiResolution): ResolvedCase {
  return {
    id: r.resolution_id,
    case_id: r.case_id,
    plot_id: r.plot_id,
    plot_label: r.plot_label,
    threat_code: r.threat_code,
    symptoms: r.symptoms,
    resolved_at: r.resolved_at,
    solution_statement: r.solution_statement ?? '',
    solution_codes: r.solution_codes,
    matches_protocol: r.matches_protocol,
    outcome: r.outcome,
    verification: r.verification,
    is_demo: r.is_demo,
  }
}

// Latest delivery outcome next to the review decision, e.g. "Alert approved · Call in progress".
function alertTimelineTitle(a: ApiAlert): string {
  const title = `Alert ${ALERT_STATUS[a.status].label.toLowerCase()}`
  const last = a.notifications.at(-1)
  return last ? `${title} · ${deliveryLabel(last).label}` : title
}

const getGraph = (threatCode: string) => request<GraphResponse>(`/graph${qs({ threat_code: threatCode })}`)

// The follow-up list doesn't carry the plot name; it's taken from the graph.
async function plotLabels(): Promise<Map<string, string>> {
  try {
    const graph = await getGraph('coffee_leaf_rust')
    return new Map(graph.nodes.map((n) => [n.id, n.label]))
  } catch {
    return new Map()
  }
}

async function getFollowupItems(): Promise<FollowUp[]> {
  const [list, labels] = await Promise.all([request<{ followups: ApiFollowup[] }>('/followups'), plotLabels()])
  return list.followups.map((f) => toFollowup(f, labels))
}

// There is no timeline endpoint: it's built from the plot's reports, advisor assessments, alerts,
// follow-ups and resolutions.
async function getTimeline(plotId: string): Promise<Page<TimelineEntry>> {
  const id = encodeURIComponent(plotId)
  const [graph, assessments, alerts, followups, resolutions] = await Promise.all([
    getGraph('coffee_leaf_rust'),
    request<{ assessments: ApiAssessment[] }>(`/plots/${id}/assessments`),
    request<{ alerts: ApiAlert[] }>(`/alerts${qs({ plot_id: plotId })}`),
    request<{ followups: ApiFollowup[] }>('/followups'),
    request<{ resolutions: ApiResolution[] }>(`/resolved-cases?plot_id=${id}`),
  ])
  const node = graph.nodes.find((n) => n.id === plotId)
  const reports = await Promise.all(
    (node?.evidence_report_ids ?? []).map((rid) => request<ApiReport>(`/reports/${encodeURIComponent(rid)}`)),
  )

  const entries: TimelineEntry[] = [
    ...reports.map((r): TimelineEntry => ({
      id: r.report_id,
      kind: 'report',
      occurred_at: r.received_at,
      title: r.channel === 'voice' ? 'Report by phone call' : 'Report by SMS',
      detail: r.user_statement || r.symptoms.join(', ') || null,
      channel: r.channel,
    })),
    ...assessments.assessments.map((a): TimelineEntry => ({
      id: a.assessment_id,
      kind: 'assessment',
      occurred_at: a.created_at,
      title: DISPOSITION_TITLE[a.disposition],
      detail: a.suspected_issue?.label ?? null,
      disposition: a.disposition,
      human_review_required: a.human_review_required,
      data_used: a.data_used,
      resolved_case_mentions: a.resolved_case_mentions,
      recommendations: a.recommendations,
    })),
    ...alerts.alerts.map((a): TimelineEntry => ({
      id: a.alert_id,
      kind: 'alert',
      occurred_at: a.approved_at ?? a.created_at,
      title: alertTimelineTitle(a),
      detail: a.message,
      channel: 'operator',
    })),
    ...followups.followups.filter((f) => f.plot_id === plotId).map((f): TimelineEntry => ({
      id: f.followup_id,
      kind: 'followup',
      occurred_at: f.due_at,
      title: `Follow-up: ${FOLLOWUP_STATUS[f.status].toLowerCase()}`,
      detail: caseSummary(f.case_summary),
      channel: f.channel,
    })),
    ...resolutions.resolutions.map((r): TimelineEntry => ({
      id: r.resolution_id,
      kind: 'resolution',
      occurred_at: r.resolved_at,
      title: 'Case resolved',
      detail: r.solution_statement,
    })),
  ]
  entries.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
  return page(entries)
}

export const httpAdapter: DashboardApi = {
  getGraph,
  getTimeline,
  getAlert: async (id) => toAlert(await request<ApiAlert>(`/alerts/${encodeURIComponent(id)}`)),
  getAlerts: async (status) =>
    page((await request<{ alerts: ApiAlert[] }>(`/alerts${qs({ status })}`)).alerts.map(toAlert)),
  reviewAlert: async (id, body: AlertReview) =>
    toAlert(await request<ApiAlert>(`/alerts/${encodeURIComponent(id)}/review`, {
      method: 'POST',
      body,
      idempotencyKey: crypto.randomUUID(),
    })),
  getFollowups: async () => page(await getFollowupItems()),
  getResolvedCases: async (plotId) =>
    page((await request<{ resolutions: ApiResolution[] }>(`/resolved-cases${qs({ plot_id: plotId })}`))
      .resolutions.map(toResolved)),
  // The backend has no /demo/reset; the button is hidden in http mode (NavBar).
  resetDemo: async () => {
    throw new ApiError(501, 'NOT_IMPLEMENTED', 'Demo reset is not available against the API. Run backend/scripts/reset_db.sh.')
  },
}
