import type {
  Alert, AlertReview, AlertStatus, FollowUp, GraphResponse, Page, ResolvedCase, TimelineEntry,
} from './types'

// Single interface every screen uses. Two implementations:
// mockAdapter (in-memory fixtures) and httpAdapter (Integrante 3's backend).
export interface DashboardApi {
  getGraph(threatCode: string): Promise<GraphResponse>
  getTimeline(plotId: string): Promise<Page<TimelineEntry>>
  getAlerts(status?: AlertStatus): Promise<Page<Alert>>
  getAlert(id: string): Promise<Alert>
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
