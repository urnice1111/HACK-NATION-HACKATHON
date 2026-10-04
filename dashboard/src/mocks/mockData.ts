import type { Alert, FollowUp, ResolvedCase, TimelineEntry } from '../api/types'

// Fixtures del dashboard (INSTRUCTIONS.md, sección 13). Las fechas son relativas
// al momento de carga para que "vencido" o "hace 5 min" tengan sentido en la demo.
export function buildMockData() {
  const now = Date.now()
  const ago = (min: number) => new Date(now - min * 60_000).toISOString()
  const inMin = (min: number) => new Date(now + min * 60_000).toISOString()
  const defaultMessage =
    'Se reportaron síntomas en la zona. Revisa tu parcela y responde si observas cambios. Este aviso no confirma afectación.'

  const alerts: Alert[] = [
    {
      id: 'alert_demo_01', plot_id: 'plot_demo_02', plot_label: 'Parcela 2', threat_code: 'coffee_leaf_rust',
      risk_evaluation_id: 'risk_demo_02', inspection_priority: 'medium', status: 'pending_review', message: defaultMessage,
      reasons: ['Vecina de un caso activo a 6 km', 'Humedad por encima de lo normal'], recipients_count: 1,
      delivery_status: null, last_error: null, version: 1, created_at: ago(4), approved_by: null, approved_at: null,
      review_reason: null, is_demo: true,
    },
    {
      id: 'alert_demo_02', plot_id: 'plot_demo_07', plot_label: 'Parcela 7', threat_code: 'coffee_leaf_rust',
      risk_evaluation_id: 'risk_demo_07', inspection_priority: 'medium', status: 'pending_review', message: defaultMessage,
      reasons: ['Vecina de un caso activo a 5 km'], recipients_count: 1, delivery_status: null, last_error: null,
      version: 1, created_at: ago(11), approved_by: null, approved_at: null, review_reason: null, is_demo: true,
    },
    {
      id: 'alert_demo_03', plot_id: 'plot_demo_03', plot_label: 'Parcela 3', threat_code: 'coffee_leaf_rust',
      risk_evaluation_id: 'risk_demo_03', inspection_priority: 'medium', status: 'queued', message: defaultMessage,
      reasons: ['Vecina de un caso activo a 7 km'], recipients_count: 1, delivery_status: 'delivered', last_error: null,
      version: 2, created_at: ago(55), approved_by: 'operador.demo', approved_at: ago(40), review_reason: 'Aviso preventivo revisado',
      is_demo: true,
    },
    {
      id: 'alert_demo_04', plot_id: 'plot_demo_04', plot_label: 'Parcela 4', threat_code: 'coffee_leaf_rust',
      risk_evaluation_id: 'risk_demo_04', inspection_priority: 'low', status: 'rejected', message: defaultMessage,
      reasons: ['Similitud ambiental con un caso activo'], recipients_count: 1, delivery_status: null, last_error: null,
      version: 2, created_at: ago(90), approved_by: 'operador.demo', approved_at: ago(85),
      review_reason: 'Solo similitud ambiental, sin exposición. No se avisa.', is_demo: true,
    },
    {
      id: 'alert_demo_05', plot_id: 'plot_demo_05', plot_label: 'Parcela 5', threat_code: 'coffee_leaf_rust',
      risk_evaluation_id: 'risk_demo_05', inspection_priority: 'medium', status: 'queued', message: defaultMessage,
      reasons: ['Vecina de un caso activo a 7 km'], recipients_count: 1, delivery_status: 'failed',
      last_error: 'El número no acepta SMS. No se reintenta.', version: 2, created_at: ago(200), approved_by: 'operador.demo',
      approved_at: ago(190), review_reason: 'Aviso preventivo revisado', is_demo: true,
    },
  ]

  const followups: FollowUp[] = [
    {
      id: 'followup_demo_01', case_id: 'case_demo_01', plot_id: 'plot_demo_01', plot_label: 'Parcela 1', due_at: ago(5),
      status: 'scheduled', channel: 'voice', attempt_count: 0, max_attempts: 3,
      case_summary: 'Manchas amarillas con polvo naranja; se recomendó retirar hojas afectadas.',
      status_reported: null, actions_taken: null, is_demo: true,
    },
    {
      id: 'followup_demo_02', case_id: 'case_demo_06', plot_id: 'plot_demo_06', plot_label: 'Parcela 6', due_at: ago(1),
      status: 'contacting', channel: 'voice', attempt_count: 1, max_attempts: 3,
      case_summary: 'Reporte por SMS de hojas con manchas; derivado a agrónomo.',
      status_reported: null, actions_taken: null, is_demo: true,
    },
    {
      id: 'followup_demo_03', case_id: 'case_demo_06', plot_id: 'plot_demo_06', plot_label: 'Parcela 6', due_at: inMin(180),
      status: 'scheduled', channel: 'voice', attempt_count: 0, max_attempts: 3,
      case_summary: 'Segundo seguimiento programado tras la revisión del agrónomo.',
      status_reported: null, actions_taken: null, is_demo: true,
    },
    {
      id: 'followup_demo_04', case_id: 'case_demo_01', plot_id: 'plot_demo_01', plot_label: 'Parcela 1', due_at: ago(130),
      status: 'no_response', channel: 'sms', attempt_count: 3, max_attempts: 3,
      case_summary: 'Primer seguimiento: tres llamadas sin respuesta; se envió SMS de respaldo.',
      status_reported: null, actions_taken: null, is_demo: true,
    },
    {
      id: 'followup_demo_05', case_id: 'case_demo_05', plot_id: 'plot_demo_05', plot_label: 'Parcela 5', due_at: ago(720),
      status: 'responded', channel: 'voice', attempt_count: 1, max_attempts: 3,
      case_summary: 'Roya sospechada en un sector de la parcela.',
      status_reported: 'resolved', actions_taken: 'Quitó y enterró hojas con manchas y reguló la sombra.', is_demo: true,
    },
  ]

  const resolved: ResolvedCase[] = [
    {
      id: 'resolution_demo_01', case_id: 'case_demo_05', plot_id: 'plot_demo_05', plot_label: 'Parcela 5',
      threat_code: 'coffee_leaf_rust', symptoms: ['manchas amarillas', 'polvo naranja en el envés'], resolved_at: ago(720),
      solution_statement: 'Retiró y enterró las hojas afectadas y reguló la sombra.',
      solution_codes: ['remove_affected_leaves', 'regulate_shade'], matches_protocol: true, outcome: 'resolved',
      verification: 'farmer_reported', is_demo: true,
    },
    {
      id: 'resolution_demo_02', case_id: 'case_demo_04', plot_id: 'plot_demo_04', plot_label: 'Parcela 4',
      threat_code: 'coffee_leaf_rust', symptoms: ['manchas amarillas'], resolved_at: ago(60 * 24 * 14),
      solution_statement: 'Poda para ventilar y control de maleza; revisado por agrónomo en visita.',
      solution_codes: ['ventilation_pruning', 'weed_control'], matches_protocol: true, outcome: 'resolved',
      verification: 'verified', is_demo: true,
    },
    {
      id: 'resolution_demo_03', case_id: 'case_demo_03', plot_id: 'plot_demo_03', plot_label: 'Parcela 3',
      threat_code: 'coffee_leaf_rust', symptoms: ['polvo naranja en el envés', 'caída de hojas'], resolved_at: ago(60 * 24 * 20),
      solution_statement: 'Aplicó un fungicida que le recomendaron en la tienda, con la dosis que le indicó el vendedor.',
      solution_codes: null, matches_protocol: false, outcome: 'improved_enough', verification: 'farmer_reported', is_demo: true,
    },
  ]

  const timeline: Record<string, TimelineEntry[]> = {
    plot_demo_01: [
      {
        id: 'tl_01_5', kind: 'followup', occurred_at: ago(5), title: 'Seguimiento vencido',
        detail: 'La llamada de seguimiento espera turno dentro del horario permitido.',
      },
      {
        id: 'tl_01_4', kind: 'risk_change', occurred_at: ago(20), title: 'Prioridad cambió a alta (0.74)',
        detail: 'Modelo 1.0.0. Contribuciones: reportes directos +0.31, humedad +0.12.',
      },
      {
        id: 'tl_01_3', kind: 'assessment', occurred_at: ago(21), title: 'El asesor dio orientación',
        detail: 'Sospecha de roya del café (sin confirmar).', disposition: 'advise',
        recommendations: [
          { code: 'remove_affected_leaves', text: 'Retirar hojas con manchas y enterrarlas fuera de la parcela', protocol_id: 'coffee-rust-demo-v1' },
          { code: 'regulate_shade', text: 'Regular la sombra para que circule el aire', protocol_id: 'coffee-rust-demo-v1' },
        ],
        resolved_case_mentions: [
          {
            resolution_id: 'resolution_demo_01',
            summary_for_speech: 'En una parcela parecida de la zona mejoró al retirar hojas afectadas y regular la sombra.',
            verification: 'farmer_reported',
          },
        ],
      },
      {
        id: 'tl_01_2', kind: 'assessment', occurred_at: ago(23), title: 'El asesor consultó datos antes de preguntar',
        detail: 'Preguntó al agricultor solo por el envés de las hojas.', disposition: 'ask_more',
        data_used: [
          { query_id: 'q_demo_01', summary: 'Humedad promedio de 14 días por encima de lo normal (82 % frente a 68 %)', data_freshness: 'fresh', dataset_ids: ['dataset_humedad_demo'] },
          { query_id: 'q_demo_02', summary: 'Lluvia acumulada de 14 días 2.3 veces lo normal', data_freshness: 'fresh', dataset_ids: ['dataset_lluvia_demo'] },
        ],
      },
      {
        id: 'tl_01_1', kind: 'report', occurred_at: ago(25), title: 'Reporte por llamada', channel: 'voice',
        detail: '"Desde ayer veo manchas en varias plantas."',
      },
    ],
    plot_demo_06: [
      {
        id: 'tl_06_2', kind: 'assessment', occurred_at: ago(48), title: 'Derivado a agrónomo',
        detail: 'El agricultor preguntó por un fungicida; el protocolo no permite recomendar productos.',
        disposition: 'refer', human_review_required: true,
      },
      {
        id: 'tl_06_1', kind: 'report', occurred_at: ago(50), title: 'Reporte por SMS', channel: 'sms',
        detail: '"Hojas con manchas cafés y polvito, ¿qué le echo?"',
      },
    ],
    plot_demo_05: [
      {
        id: 'tl_05_2', kind: 'resolution', occurred_at: ago(720), title: 'Caso resuelto según el agricultor',
        detail: 'Quitó y enterró hojas con manchas y reguló la sombra. Verificación: reportado por el agricultor.',
      },
      {
        id: 'tl_05_1', kind: 'report', occurred_at: ago(60 * 24 * 12), title: 'Reporte por llamada', channel: 'voice',
        detail: '"Tengo un sector con hojas amarillas."',
      },
    ],
  }

  return { alerts, followups, resolved, timeline }
}
