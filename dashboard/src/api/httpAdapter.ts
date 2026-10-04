import { ApiError, type DashboardApi } from './client'
import type {
  Alert, AlertReview, ApiErrorBody, FollowUp, GraphResponse, Page, ResolvedCase, TimelineEntry,
} from './types'

const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8000/v1'

let tokenProvider: () => Promise<string | null> = async () => null

// AuthContext registra aquí cómo obtener el JWT de Supabase.
export function setTokenProvider(fn: () => Promise<string | null>) {
  tokenProvider = fn
}

type RequestOptions = { method?: string; body?: unknown; idempotencyKey?: string }

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const token = await tokenProvider()
  if (token) headers.Authorization = `Bearer ${token}`
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
    throw new ApiError(0, 'NETWORK_ERROR', 'No se pudo conectar con el servidor.', true)
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

export const httpAdapter: DashboardApi = {
  getGraph: (threatCode) => request<GraphResponse>(`/graph${qs({ threat_code: threatCode })}`),
  getTimeline: (plotId) => request<Page<TimelineEntry>>(`/plots/${encodeURIComponent(plotId)}/timeline`),
  getAlerts: (status) => request<Page<Alert>>(`/alerts${qs({ status })}`),
  reviewAlert: (id, body: AlertReview) =>
    request<Alert>(`/alerts/${encodeURIComponent(id)}/review`, {
      method: 'POST',
      body,
      idempotencyKey: crypto.randomUUID(),
    }),
  getFollowups: () => request<Page<FollowUp>>('/followups'),
  getResolvedCases: (plotId) => request<Page<ResolvedCase>>(`/resolved-cases${qs({ plot_id: plotId })}`),
  // Endpoint no definido en los contratos: pedírselo al integrante 3.
  resetDemo: () => request<void>('/demo/reset', { method: 'POST', idempotencyKey: crypto.randomUUID() }),
}
