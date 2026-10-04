import type {
  Alert, AlertReview, AlertStatus, FollowUp, GraphResponse, Page, ResolvedCase, TimelineEntry,
} from './types'

// Interfaz única que usan todas las pantallas. Hay dos implementaciones:
// mockAdapter (fixtures en memoria) y httpAdapter (backend del integrante 3).
export interface DashboardApi {
  getGraph(threatCode: string): Promise<GraphResponse>
  getTimeline(plotId: string): Promise<Page<TimelineEntry>>
  getAlerts(status?: AlertStatus): Promise<Page<Alert>>
  reviewAlert(id: string, body: AlertReview): Promise<Alert>
  getFollowups(): Promise<Page<FollowUp>>
  getResolvedCases(plotId?: string): Promise<Page<ResolvedCase>>
  resetDemo(): Promise<void>
}

export class ApiError extends Error {
  status: number
  code: string
  retryable: boolean

  constructor(status: number, code: string, message: string, retryable = false) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryable = retryable
  }
}
