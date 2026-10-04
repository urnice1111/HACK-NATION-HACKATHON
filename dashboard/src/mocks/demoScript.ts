import type {
  Alert,
  FollowUp,
  GraphNode,
  GraphResponse,
  ResolvedCase,
  TimelineEntry,
} from '../api/types'
import graphFixture from './graph.json'

export const DEMO_DURATION_MS = 60_000

export type DemoState = {
  alerts: Alert[]
  followups: FollowUp[]
  resolved: ResolvedCase[]
  timeline: Record<string, TimelineEntry[]>
  graph: GraphResponse
}

export type DemoEvent = {
  atMs: number
  simNow: number
  caption: string
  route?: string
  /** No interpolar el reloj hasta este beat: es un corte de time-lapse. */
  jump?: boolean
  apply: (state: DemoState) => void
}

/** Día 1, 09:00 en America/Mexico_City (UTC−6). */
export const DAY1 = Date.UTC(2026, 9, 6, 15, 0, 0)

const clockFmt = new Intl.DateTimeFormat('es-MX', {
  timeZone: 'America/Mexico_City',
  hour: '2-digit',
  minute: '2-digit',
})
const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Mexico_City',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export function formatSimClock(ms: number): string {
  const start = Date.parse(dayFmt.format(DAY1))
  const current = Date.parse(dayFmt.format(ms))
  const day = 1 + Math.round((current - start) / 86_400_000)
  return `Día ${day} · ${clockFmt.format(ms)}`
}

function t(day: 1 | 4, hh: number, mm: number): number {
  const date = day === 1 ? 6 : 9
  return Date.UTC(2026, 9, date, hh + 6, mm, 0)
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function ago(from: number, min: number): string {
  return iso(from - min * 60_000)
}

const ALERT_MESSAGE =
  'Coffee leaf rust symptoms were reported nearby. Check your plot and tell us if you see changes. This alert does not confirm your plot is affected.'

function node(state: DemoState, id: string): GraphNode {
  const found = state.graph.nodes.find((n) => n.id === id)
  if (!found) throw new Error(`Parcela no encontrada: ${id}`)
  return found
}

function edge(state: DemoState, id: string) {
  const found = state.graph.edges.find((e) => e.id === id)
  if (!found) throw new Error(`Arista no encontrada: ${id}`)
  return found
}

function addTimeline(state: DemoState, plotId: string, ...entries: TimelineEntry[]) {
  state.timeline[plotId] = [...entries, ...(state.timeline[plotId] ?? [])]
}

function patchNode(state: DemoState, id: string, patch: Partial<GraphNode>) {
  Object.assign(node(state, id), patch)
}

function historicalResolved(from: number): ResolvedCase[] {
  return [
    {
      id: 'resolution_demo_01',
      case_id: 'case_demo_05',
      plot_id: 'plot_demo_05',
      plot_label: 'Parcela 5',
      threat_code: 'coffee_leaf_rust',
      symptoms: ['manchas amarillas', 'polvo naranja en el envés'],
      resolved_at: ago(from, 60 * 24 * 12),
      solution_statement: 'Retiró y enterró las hojas afectadas y reguló la sombra.',
      solution_codes: ['remove_affected_leaves', 'regulate_shade'],
      matches_protocol: true,
      outcome: 'resolved',
      verification: 'farmer_reported',
      is_demo: true,
    },
    {
      id: 'resolution_demo_02',
      case_id: 'case_demo_04',
      plot_id: 'plot_demo_04',
      plot_label: 'Parcela 4',
      threat_code: 'coffee_leaf_rust',
      symptoms: ['manchas amarillas'],
      resolved_at: ago(from, 60 * 24 * 14),
      solution_statement: 'Poda para ventilar y control de maleza; revisado por agrónomo en visita.',
      solution_codes: ['ventilation_pruning', 'weed_control'],
      matches_protocol: true,
      outcome: 'resolved',
      verification: 'verified',
      is_demo: true,
    },
    {
      id: 'resolution_demo_03',
      case_id: 'case_demo_03',
      plot_id: 'plot_demo_03',
      plot_label: 'Parcela 3',
      threat_code: 'coffee_leaf_rust',
      symptoms: ['polvo naranja en el envés', 'caída de hojas'],
      resolved_at: ago(from, 60 * 24 * 20),
      solution_statement: 'Aplicó un fungicida que le recomendaron en la tienda, con la dosis que le indicó el vendedor.',
      solution_codes: null,
      matches_protocol: false,
      outcome: 'improved_enough',
      verification: 'farmer_reported',
      is_demo: true,
    },
  ]
}

export function buildSimStart(): DemoState {
  const graph = structuredClone(graphFixture) as unknown as GraphResponse
  graph.generated_at = iso(DAY1)
  graph.graph_version = 1

  const n = (id: string) => {
    const found = graph.nodes.find((item) => item.id === id)
    if (!found) throw new Error(`Parcela no encontrada: ${id}`)
    return found
  }

  Object.assign(n('plot_demo_01'), {
    inspection_priority: 'low',
    score: 0.21,
    contributions: [{ feature: 'humidity_mean_14d', value: 0.04 }],
    local_case_status: 'none',
    data_freshness: 'fresh',
    risk_evaluation_id: 'risk_sim_01_start',
    reasons: ['Sin reportes cercanos'],
    evidence_report_ids: [],
  })
  Object.assign(n('plot_demo_02'), {
    inspection_priority: 'low',
    score: 0.2,
    contributions: [{ feature: 'humidity_mean_14d', value: 0.06 }],
    local_case_status: 'none',
    data_freshness: 'fresh',
    risk_evaluation_id: 'risk_sim_02_start',
    reasons: ['Humedad ligeramente por encima de lo normal'],
    evidence_report_ids: [],
  })
  Object.assign(n('plot_demo_03'), {
    inspection_priority: 'low',
    score: 0.18,
    contributions: [{ feature: 'rain_anomaly_30d', value: 0.05 }],
    local_case_status: 'none',
    data_freshness: 'fresh',
    risk_evaluation_id: 'risk_sim_03_start',
    reasons: ['Sin reportes cercanos'],
    evidence_report_ids: [],
  })

  for (const id of ['edge_01_02', 'edge_01_03']) {
    const e = graph.edges.find((item) => item.id === id)
    if (e) e.exposure_strength = null
  }

  return {
    graph,
    alerts: [],
    followups: [],
    resolved: historicalResolved(DAY1),
    timeline: {
      plot_demo_05: [
        {
          id: 'tl_05_2',
          kind: 'resolution',
          occurred_at: ago(DAY1, 60 * 24 * 12),
          title: 'Caso resuelto según el agricultor',
          detail: 'Quitó y enterró hojas con manchas y reguló la sombra. Verificación: reportado por el agricultor.',
        },
        {
          id: 'tl_05_1',
          kind: 'report',
          occurred_at: ago(DAY1, 60 * 24 * 14),
          title: 'Reporte por llamada',
          channel: 'voice',
          detail: '"Tengo un sector con hojas amarillas."',
        },
      ],
      plot_demo_06: [
        {
          id: 'tl_06_2',
          kind: 'assessment',
          occurred_at: ago(DAY1, 48),
          title: 'Derivado a agrónomo',
          detail: 'El agricultor preguntó por un fungicida; el protocolo no permite recomendar productos.',
          disposition: 'refer',
          human_review_required: true,
        },
        {
          id: 'tl_06_1',
          kind: 'report',
          occurred_at: ago(DAY1, 50),
          title: 'Reporte por SMS',
          channel: 'sms',
          detail: '"Hojas con manchas cafés y polvito, ¿qué le echo?"',
        },
      ],
    },
  }
}

/** The voice call queued when the operator approved alert_sim_02. */
function alertCall(state: DemoState) {
  return findAlert(state, 'alert_sim_02').notifications[0]!
}

function findAlert(state: DemoState, id: string): Alert {
  const found = state.alerts.find((a) => a.id === id)
  if (!found) throw new Error(`Alerta no encontrada: ${id}`)
  return found
}

function findFollowup(state: DemoState, id: string): FollowUp {
  const found = state.followups.find((f) => f.id === id)
  if (!found) throw new Error(`Seguimiento no encontrado: ${id}`)
  return found
}

export const DEMO_EVENTS: DemoEvent[] = [
  {
    atMs: 0,
    simNow: t(1, 9, 0),
    caption: 'Red de 8 parcelas · datos simulados identificados',
    route: '/',
    apply: () => {},
  },
  {
    atMs: 8_000,
    simNow: t(1, 9, 18),
    caption: 'Llamada: manchas en varias plantas de la parcela 1',
    route: '/plot/plot_demo_01',
    apply: (state) => {
      patchNode(state, 'plot_demo_01', {
        local_case_status: 'reported',
        reasons: ['Reporte directo recibido', 'Aún sin recálculo de prioridad'],
        evidence_report_ids: ['report_sim_01'],
      })
      addTimeline(state, 'plot_demo_01', {
        id: 'tl_sim_01_report',
        kind: 'report',
        occurred_at: iso(t(1, 9, 18)),
        title: 'Reporte por llamada',
        channel: 'voice',
        detail: '"Desde ayer veo manchas en varias plantas."',
      })
    },
  },
  {
    atMs: 14_000,
    simNow: t(1, 9, 22),
    caption: 'El asesor consultó humedad y lluvia antes de preguntar',
    apply: (state) => {
      addTimeline(state, 'plot_demo_01', {
        id: 'tl_sim_01_ask',
        kind: 'assessment',
        occurred_at: iso(t(1, 9, 22)),
        title: 'El asesor consultó datos antes de preguntar',
        detail: 'Preguntó al agricultor solo por el envés de las hojas.',
        disposition: 'ask_more',
        data_used: [
          {
            query_id: 'q_sim_01',
            summary: 'Humedad promedio de 14 días por encima de lo normal (82 % frente a 68 %)',
            data_freshness: 'fresh',
            dataset_ids: ['dataset_humedad_demo'],
          },
          {
            query_id: 'q_sim_02',
            summary: 'Lluvia acumulada de 14 días 2.3 veces lo normal',
            data_freshness: 'fresh',
            dataset_ids: ['dataset_lluvia_demo'],
          },
        ],
      })
    },
  },
  {
    atMs: 20_000,
    simNow: t(1, 9, 25),
    caption: 'El modelo sube la prioridad; los vecinos se exponen',
    apply: (state) => {
      state.graph.graph_version += 1
      state.graph.generated_at = iso(t(1, 9, 25))
      patchNode(state, 'plot_demo_01', {
        inspection_priority: 'high',
        score: 0.74,
        contributions: [
          { feature: 'direct_active_reports', value: 0.31 },
          { feature: 'humidity_mean_14d', value: 0.12 },
          { feature: 'rain_anomaly_30d', value: 0.08 },
        ],
        local_case_status: 'suspected',
        risk_evaluation_id: 'risk_sim_01',
        reasons: ['Reporte directo activo', 'Humedad por encima de lo normal'],
      })
      patchNode(state, 'plot_demo_02', {
        inspection_priority: 'medium',
        score: 0.52,
        contributions: [
          { feature: 'neighbor_source_exposure', value: 0.19 },
          { feature: 'humidity_mean_14d', value: 0.1 },
        ],
        risk_evaluation_id: 'risk_sim_02',
        reasons: ['Vecina de un caso activo a 6 km', 'Humedad por encima de lo normal'],
      })
      patchNode(state, 'plot_demo_03', {
        inspection_priority: 'medium',
        score: 0.47,
        contributions: [
          { feature: 'neighbor_source_exposure', value: 0.15 },
          { feature: 'rain_anomaly_30d', value: 0.09 },
        ],
        risk_evaluation_id: 'risk_sim_03',
        reasons: ['Vecina de un caso activo a 7 km'],
      })
      edge(state, 'edge_01_02').exposure_strength = 0.31
      edge(state, 'edge_01_03').exposure_strength = 0.26
      addTimeline(
        state,
        'plot_demo_01',
        {
          id: 'tl_sim_01_risk',
          kind: 'risk_change',
          occurred_at: iso(t(1, 9, 25)),
          title: 'Prioridad cambió a alta (0.74)',
          detail: 'Modelo 1.0.0. Contribuciones: reportes directos +0.31, humedad +0.12.',
        },
        {
          id: 'tl_sim_01_advise',
          kind: 'assessment',
          occurred_at: iso(t(1, 9, 25)),
          title: 'El asesor dio orientación',
          detail: 'Sospecha de roya del café (sin confirmar).',
          disposition: 'advise',
          recommendations: [
            {
              code: 'remove_affected_leaves',
              text: 'Retirar hojas con manchas y enterrarlas fuera de la parcela',
              protocol_id: 'coffee-rust-demo-v1',
            },
            {
              code: 'regulate_shade',
              text: 'Regular la sombra para que circule el aire',
              protocol_id: 'coffee-rust-demo-v1',
            },
          ],
          resolved_case_mentions: [
            {
              resolution_id: 'resolution_demo_01',
              summary_for_speech: 'En una parcela parecida de la zona mejoró al retirar hojas afectadas y regular la sombra.',
              verification: 'farmer_reported',
            },
          ],
        },
      )
      state.followups.push({
        id: 'followup_sim_01',
        case_id: 'case_sim_01',
        plot_id: 'plot_demo_01',
        plot_label: 'Parcela 1',
        due_at: iso(t(4, 9, 25)),
        status: 'scheduled',
        channel: 'voice',
        attempt_count: 0,
        max_attempts: 3,
        case_summary: 'Manchas amarillas con polvo naranja; se recomendó retirar hojas afectadas.',
        status_reported: null,
        actions_taken: null,
        is_demo: true,
      })
    },
  },
  {
    atMs: 26_000,
    simNow: t(1, 9, 31),
    caption: 'Alerta preventiva lista para revisión',
    route: '/alerts',
    apply: (state) => {
      state.alerts.unshift({
        id: 'alert_sim_02',
        plot_id: 'plot_demo_02',
        plot_label: 'Parcela 2',
        threat_code: 'coffee_leaf_rust',
        risk_evaluation_id: 'risk_sim_02',
        inspection_priority: 'medium',
        status: 'pending_review',
        message: ALERT_MESSAGE,
        reasons: ['Vecina de un caso activo a 6 km', 'Humedad por encima de lo normal'],
        recipient_label: 'Demo farmer 2',
        notifications: [],
        version: 1,
        created_at: iso(t(1, 9, 31)),
        approved_by: null,
        approved_at: null,
        review_reason: null,
        is_demo: true,
      })
      addTimeline(state, 'plot_demo_02', {
        id: 'tl_sim_02_alert',
        kind: 'alert',
        occurred_at: iso(t(1, 9, 31)),
        title: 'Alerta preventiva propuesta',
        detail: 'Pendiente de revisión humana. No se envía sola.',
      })
    },
  },
  {
    atMs: 32_000,
    simNow: t(1, 9, 33),
    caption: 'The operator approves; the alert call is queued',
    apply: (state) => {
      const alert = findAlert(state, 'alert_sim_02')
      alert.status = 'queued'
      alert.notifications = [
        { notification_id: 'notification_sim_02', channel: 'voice', status: 'queued', attempt_count: 0, last_error: null },
      ]
      alert.version = 2
      alert.approved_by = 'operador.demo'
      alert.approved_at = iso(t(1, 9, 33))
      alert.review_reason = 'Aviso preventivo revisado'
    },
  },
  {
    atMs: 34_000,
    simNow: t(1, 9, 35),
    caption: 'Calling the farmer of plot 2',
    apply: (state) => {
      Object.assign(alertCall(state), { status: 'sending', attempt_count: 1 })
    },
  },
  {
    atMs: 37_000,
    simNow: t(1, 9, 37),
    caption: 'The call is in progress',
    apply: (state) => {
      alertCall(state).status = 'accepted'
    },
  },
  {
    atMs: 40_000,
    simNow: t(1, 9, 40),
    caption: 'The farmer confirmed they heard the alert',
    apply: (state) => {
      alertCall(state).status = 'delivered'
    },
  },
  {
    atMs: 42_000,
    simNow: t(4, 10, 0),
    caption: 'Tres días después: toca la llamada de seguimiento',
    route: '/followups',
    jump: true,
    apply: (state) => {
      addTimeline(state, 'plot_demo_01', {
        id: 'tl_sim_01_followup',
        kind: 'followup',
        occurred_at: iso(t(4, 9, 25)),
        title: 'Seguimiento vencido',
        detail: 'La llamada de seguimiento espera turno dentro del horario permitido.',
      })
    },
  },
  {
    atMs: 48_000,
    simNow: t(4, 10, 4),
    caption: 'Llamada de seguimiento en curso',
    apply: (state) => {
      const followup = findFollowup(state, 'followup_sim_01')
      followup.status = 'contacting'
      followup.attempt_count = 1
    },
  },
  {
    atMs: 54_000,
    simNow: t(4, 10, 8),
    caption: 'Se resolvió: deja de ser caso fuente y los vecinos bajan',
    route: '/resolved',
    apply: (state) => {
      const followup = findFollowup(state, 'followup_sim_01')
      followup.status = 'responded'
      followup.status_reported = 'resolved'
      followup.actions_taken = 'Quitó y enterró hojas con manchas y reguló la sombra.'
      state.resolved.unshift({
        id: 'resolution_sim_01',
        case_id: 'case_sim_01',
        plot_id: 'plot_demo_01',
        plot_label: 'Parcela 1',
        threat_code: 'coffee_leaf_rust',
        symptoms: ['manchas amarillas', 'polvo naranja en el envés'],
        resolved_at: iso(t(4, 10, 8)),
        solution_statement: 'Retiró y enterró las hojas afectadas y reguló la sombra.',
        solution_codes: ['remove_affected_leaves', 'regulate_shade'],
        matches_protocol: true,
        outcome: 'resolved',
        verification: 'farmer_reported',
        is_demo: true,
      })
      state.graph.graph_version += 1
      state.graph.generated_at = iso(t(4, 10, 8))
      patchNode(state, 'plot_demo_01', {
        inspection_priority: 'low',
        score: 0.26,
        contributions: [{ feature: 'humidity_mean_14d', value: 0.05 }],
        local_case_status: 'resolved',
        risk_evaluation_id: 'risk_sim_01_resolved',
        reasons: ['Caso resuelto hoy según el agricultor'],
        evidence_report_ids: ['report_sim_01'],
      })
      patchNode(state, 'plot_demo_02', {
        inspection_priority: 'low',
        score: 0.24,
        contributions: [{ feature: 'humidity_mean_14d', value: 0.08 }],
        risk_evaluation_id: 'risk_sim_02_after',
        reasons: ['El caso vecino se resolvió'],
      })
      patchNode(state, 'plot_demo_03', {
        inspection_priority: 'low',
        score: 0.2,
        contributions: [{ feature: 'rain_anomaly_30d', value: 0.04 }],
        risk_evaluation_id: 'risk_sim_03_after',
        reasons: ['El caso vecino se resolvió'],
      })
      edge(state, 'edge_01_02').exposure_strength = null
      edge(state, 'edge_01_03').exposure_strength = null
      addTimeline(state, 'plot_demo_01', {
        id: 'tl_sim_01_resolution',
        kind: 'resolution',
        occurred_at: iso(t(4, 10, 8)),
        title: 'Caso resuelto según el agricultor',
        detail: 'Quitó y enterró hojas con manchas y reguló la sombra. Verificación: reportado por el agricultor.',
      })
    },
  },
  {
    atMs: 60_000,
    simNow: t(4, 10, 8),
    caption: 'Fin de la simulación',
    apply: () => {},
  },
]
