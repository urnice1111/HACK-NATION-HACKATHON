import { ApiError, type DashboardApi } from './client'
import type { GraphResponse } from './types'
import graphFixture from '../mocks/graph.json'
import { buildMockData } from '../mocks/mockData'
import {
  DEMO_DURATION_MS,
  DEMO_EVENTS,
  buildSimStart,
  formatSimClock,
  type DemoState,
} from '../mocks/demoScript'

type State = DemoState

const fresh = (): State => ({
  ...buildMockData(),
  graph: structuredClone(graphFixture) as unknown as GraphResponse,
})

let state = fresh()
let offline = false
let demoActive = false
let playing = false
let finished = false
let elapsedMs = 0
let startedWall = 0
let eventIndex = 0
let simNow = Date.now()
let caption = ''
let route: string | null = null
let timer: ReturnType<typeof setInterval> | null = null
let deliveryTimers: ReturnType<typeof setTimeout>[] = []
const listeners = new Set<() => void>()

export type DemoSnapshot = {
  active: boolean
  playing: boolean
  finished: boolean
  elapsedMs: number
  durationMs: number
  simNow: number
  clockLabel: string
  caption: string
  route: string | null
}

function notify() {
  for (const fn of listeners) fn()
}

function clearTimer() {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

function clearDeliveryTimers() {
  for (const id of deliveryTimers) clearTimeout(id)
  deliveryTimers = []
}

function interpolateSimNow(elapsed: number): number {
  let prev = DEMO_EVENTS[0]
  let next = DEMO_EVENTS[DEMO_EVENTS.length - 1]
  for (const ev of DEMO_EVENTS) {
    if (ev.atMs <= elapsed) prev = ev
    if (ev.atMs >= elapsed) {
      next = ev
      break
    }
  }
  if (next.jump || next.atMs === prev.atMs) return prev.simNow
  const t = (elapsed - prev.atMs) / (next.atMs - prev.atMs)
  return prev.simNow + (next.simNow - prev.simNow) * t
}

function applyDue() {
  while (eventIndex < DEMO_EVENTS.length && DEMO_EVENTS[eventIndex].atMs <= elapsedMs) {
    const ev = DEMO_EVENTS[eventIndex]
    ev.apply(state)
    caption = ev.caption
    if (ev.route !== undefined) route = ev.route
    simNow = ev.simNow
    eventIndex += 1
  }
}

function tick() {
  elapsedMs = Math.min(DEMO_DURATION_MS, performance.now() - startedWall)
  applyDue()
  simNow = interpolateSimNow(elapsedMs)
  if (elapsedMs >= DEMO_DURATION_MS) {
    playing = false
    finished = true
    caption = 'Fin de la simulación'
    clearTimer()
  }
  notify()
}

function startPlayback() {
  clearTimer()
  clearDeliveryTimers()
  state = buildSimStart()
  demoActive = true
  playing = true
  finished = false
  elapsedMs = 0
  eventIndex = 0
  route = '/'
  caption = DEMO_EVENTS[0]?.caption ?? ''
  simNow = DEMO_EVENTS[0]?.simNow ?? Date.now()
  applyDue()
  startedWall = performance.now()
  timer = setInterval(tick, 250)
  notify()
}

function pausePlayback() {
  if (!playing) return
  elapsedMs = Math.min(DEMO_DURATION_MS, performance.now() - startedWall)
  playing = false
  clearTimer()
  notify()
}

function resumePlayback() {
  if (!demoActive || finished || playing) return
  playing = true
  startedWall = performance.now() - elapsedMs
  timer = setInterval(tick, 250)
  notify()
}

function stopPlayback() {
  clearTimer()
  clearDeliveryTimers()
  demoActive = false
  playing = false
  finished = false
  elapsedMs = 0
  eventIndex = 0
  route = null
  caption = ''
  simNow = Date.now()
  state = fresh()
  notify()
}

function snapshot(): DemoSnapshot {
  return {
    active: demoActive,
    playing,
    finished,
    elapsedMs,
    durationMs: DEMO_DURATION_MS,
    simNow: demoActive ? simNow : Date.now(),
    clockLabel: demoActive ? formatSimClock(simNow) : '',
    caption: demoActive ? caption : 'Pulsa Play para ver el minuto de la demo',
    route,
  }
}

export const mockControls = {
  setOffline: (value: boolean) => {
    offline = value
  },
  isOffline: () => offline,
  getNow: () => (demoActive ? simNow : Date.now()),
  getSnapshot: snapshot,
  subscribe: (fn: () => void) => {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
  startDemo: () => {
    if (demoActive && !finished && !playing) resumePlayback()
    else startPlayback()
  },
  pauseDemo: pausePlayback,
  resetDemo: stopPlayback,
}

async function respond<T>(fn: () => T, ms = 250): Promise<T> {
  if (!demoActive) await new Promise((r) => setTimeout(r, ms))
  if (offline) throw new ApiError(0, 'NETWORK_ERROR', 'No se pudo conectar con el servidor.', true)
  return structuredClone(fn())
}

const page = <T>(items: T[]) => ({ items, next_cursor: null })

export const mockAdapter: DashboardApi = {
  getGraph: (threatCode) =>
    respond(() => {
      if (threatCode !== state.graph.threat_code) return { ...state.graph, nodes: [], edges: [] }
      return state.graph
    }),

  getTimeline: (plotId) => respond(() => page(state.timeline[plotId] ?? [])),

  getAlerts: (status) =>
    respond(() => page(status ? state.alerts.filter((a) => a.status === status) : state.alerts)),

  reviewAlert: (id, body) =>
    respond(() => {
      const alert = state.alerts.find((a) => a.id === id)
      if (!alert) throw new ApiError(404, 'NOT_FOUND', 'La alerta no existe.')
      if (alert.status !== 'pending_review') {
        throw new ApiError(409, 'ALERT_NOT_PENDING', 'Esta alerta ya fue revisada por otra persona.')
      }
      if (alert.version !== body.expected_version) {
        throw new ApiError(409, 'VERSION_CONFLICT', 'La alerta cambió desde que la abriste. Revisa la versión actual.')
      }
      alert.version += 1
      alert.review_reason = body.reason || null
      alert.approved_by = 'operador.demo'
      alert.approved_at = new Date(mockControls.getNow()).toISOString()
      if (body.decision === 'reject') {
        alert.status = 'rejected'
        return alert
      }
      alert.message = body.message
      alert.status = 'queued'
      alert.delivery_status = 'queued'
      if (!demoActive) {
        const advance = (to: 'sending' | 'accepted' | 'delivered', ms: number) => {
          const handle = setTimeout(() => {
            const current = state.alerts.find((a) => a.id === id)
            if (current) current.delivery_status = to
          }, ms)
          deliveryTimers.push(handle)
        }
        advance('sending', 3000)
        advance('accepted', 6000)
        advance('delivered', 11000)
      }
      return alert
    }, 500),

  getFollowups: () => respond(() => page(state.followups)),

  getResolvedCases: (plotId) =>
    respond(() => page(plotId ? state.resolved.filter((r) => r.plot_id === plotId) : state.resolved)),

  resetDemo: () =>
    respond(() => {
      stopPlayback()
    }),
}
