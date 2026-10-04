// Tipos copiados del contrato GET /v1/graph (INSTRUCTIONS.md, sección 10.6).
// No cambiar nombres sin acuerdo con el integrante 3.

export type InspectionPriority = 'unknown' | 'low' | 'medium' | 'high'
export type LocalCaseStatus = 'none' | 'reported' | 'suspected' | 'confirmed' | 'monitoring' | 'resolved'
export type DataFreshness = 'fresh' | 'stale' | 'unknown'

export interface Contribution {
  feature: string
  value: number
}

export interface GraphNode {
  id: string
  label: string
  latitude: number
  longitude: number
  inspection_priority: InspectionPriority
  score: number | null
  contributions: Contribution[]
  model_version: string | null
  local_case_status: LocalCaseStatus
  data_freshness: DataFreshness
  risk_evaluation_id: string | null
  reasons: string[]
  evidence_report_ids: string[]
  heuristic: boolean
  is_demo: boolean
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  distance_km: number
  environment_similarity: number | null
  exposure_type: string
  exposure_strength: number | null
  missing_features: string[]
  rule_version: string
}

export interface GraphResponse {
  schema_version: string
  graph_version: number
  generated_at: string
  threat_code: string
  nodes: GraphNode[]
  edges: GraphEdge[]
}

// ---------------------------------------------------------------------------
// Contratos del dashboard. Las rutas están en INSTRUCTIONS.md (sección 10), pero
// el JSON exacto de alertas, seguimientos, timeline y casos resueltos no está
// definido. Estos tipos son una PROPUESTA basada en los modelos de la sección 9:
// acordarlos con el integrante 3 antes de conectar.
// ---------------------------------------------------------------------------

export interface Page<T> {
  items: T[]
  next_cursor: string | null
}

export type AlertStatus = 'pending_review' | 'approved' | 'rejected' | 'cancelled' | 'queued'
export type NotificationStatus = 'queued' | 'sending' | 'accepted' | 'delivered' | 'failed' | 'unknown' | 'cancelled'

export interface Alert {
  id: string
  plot_id: string
  plot_label: string
  threat_code: string
  risk_evaluation_id: string
  inspection_priority: InspectionPriority
  status: AlertStatus
  message: string
  reasons: string[]
  recipients_count: number
  delivery_status: NotificationStatus | null
  last_error: string | null
  version: number
  created_at: string
  approved_by: string | null
  approved_at: string | null
  review_reason: string | null
  is_demo: boolean
}

// Cuerpo de POST /v1/alerts/{id}/review (sección 10.7).
export interface AlertReview {
  decision: 'approve' | 'reject'
  expected_version: number
  reason: string
  message: string
}

export type FollowUpStatus = 'scheduled' | 'contacting' | 'responded' | 'no_response' | 'failed' | 'cancelled'
export type StatusReported = 'worse' | 'same' | 'improved' | 'resolved' | 'unknown'

export interface FollowUp {
  id: string
  case_id: string
  plot_id: string
  plot_label: string
  due_at: string
  status: FollowUpStatus
  channel: 'voice' | 'sms'
  attempt_count: number
  max_attempts: number
  case_summary: string
  status_reported: StatusReported | null
  actions_taken: string | null
  is_demo: boolean
}

export type Verification = 'farmer_reported' | 'verified' | 'disputed'

export interface DataUsed {
  query_id: string
  summary: string
  data_freshness: DataFreshness
  dataset_ids: string[]
}

export interface ResolvedMention {
  resolution_id: string
  summary_for_speech: string
  verification: Verification
}

export interface Recommendation {
  code: string
  text: string
  protocol_id: string
}

export interface TimelineEntry {
  id: string
  kind: 'report' | 'assessment' | 'risk_change' | 'alert' | 'followup' | 'resolution'
  occurred_at: string
  title: string
  detail: string | null
  channel?: 'voice' | 'sms' | 'operator'
  disposition?: 'ask_more' | 'advise' | 'refer'
  human_review_required?: boolean
  data_used?: DataUsed[]
  resolved_case_mentions?: ResolvedMention[]
  recommendations?: Recommendation[]
}

export interface ResolvedCase {
  id: string
  case_id: string
  plot_id: string
  plot_label: string
  threat_code: string
  symptoms: string[]
  resolved_at: string
  solution_statement: string
  solution_codes: string[] | null
  matches_protocol: boolean | null
  outcome: 'resolved' | 'improved_enough'
  verification: Verification
  is_demo: boolean
}

// Error uniforme (sección 8).
export interface ApiErrorBody {
  error: {
    code: string
    message: string
    retryable: boolean
    request_id: string
    details?: { field: string; reason: string }[]
  }
}
