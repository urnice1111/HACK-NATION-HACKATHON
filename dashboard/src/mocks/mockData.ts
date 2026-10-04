import type { Alert, AlertNotification, FollowUp, ResolvedCase, TimelineEntry } from '../api/types'

// Dashboard fixtures (INSTRUCTIONS.md, section 13). Dates are relative to load time so
// "overdue" or "5 min ago" make sense during the demo.
export function buildMockData() {
  const now = Date.now()
  const ago = (min: number) => new Date(now - min * 60_000).toISOString()
  const inMin = (min: number) => new Date(now + min * 60_000).toISOString()
  const defaultMessage =
    'Symptoms were reported near your plot. Please check your plants and tell us if you see changes. This alert does not confirm your plot is affected.'

  let seq = 0
  const call = (status: AlertNotification['status'], attempt_count: number, last_error: string | null = null): AlertNotification[] => [
    { notification_id: `notification_demo_${String(++seq).padStart(2, '0')}`, channel: 'voice', status, attempt_count, last_error },
  ]

  type Fixture = Pick<Alert, 'id' | 'plot_id' | 'plot_label' | 'recipient_label' | 'inspection_priority' | 'reasons'> & Partial<Alert>
  const alert = (a: Fixture, createdMinAgo: number, reviewedMinAgo?: number): Alert => ({
    threat_code: 'coffee_leaf_rust',
    risk_evaluation_id: a.id.replace('alert', 'risk'),
    status: reviewedMinAgo === undefined ? 'pending_review' : 'queued',
    message: defaultMessage,
    version: reviewedMinAgo === undefined ? 1 : 2,
    created_at: ago(createdMinAgo),
    approved_by: reviewedMinAgo === undefined ? null : 'operator.demo',
    approved_at: reviewedMinAgo === undefined ? null : ago(reviewedMinAgo),
    review_reason: reviewedMinAgo === undefined ? null : 'Preventive alert reviewed',
    notifications: [],
    is_demo: true,
    ...a,
  })

  const near = (km: number) => `Neighbor of an active case ${km} km away`
  const plot = (n: number) => ({ plot_id: `plot_demo_0${n}`, plot_label: `Plot ${n}`, recipient_label: `Demo farmer ${n}` })

  // Pending first, then one reviewed alert per delivery state so every label can be checked.
  const alerts: Alert[] = [
    alert({ id: 'alert_demo_01', ...plot(2), inspection_priority: 'medium', reasons: [near(6), 'Humidity above normal'] }, 4),
    alert({ id: 'alert_demo_02', ...plot(7), inspection_priority: 'medium', reasons: [near(5)] }, 11),
    alert({ id: 'alert_demo_03', ...plot(3), inspection_priority: 'medium', reasons: [near(7)], notifications: call('queued', 0) }, 20, 1),
    alert({ id: 'alert_demo_04', ...plot(6), inspection_priority: 'high', reasons: ['Active direct report'], notifications: call('sending', 2) }, 30, 6),
    alert({ id: 'alert_demo_05', ...plot(1), inspection_priority: 'high', reasons: ['Active direct report'], notifications: call('accepted', 1) }, 35, 3),
    alert({ id: 'alert_demo_06', ...plot(3), inspection_priority: 'medium', reasons: [near(7)], notifications: call('delivered', 1) }, 55, 40),
    alert({ id: 'alert_demo_07', ...plot(2), inspection_priority: 'medium', reasons: [near(6)], notifications: call('failed', 3, 'NO_ANSWER') }, 200, 190),
    alert({ id: 'alert_demo_08', ...plot(7), inspection_priority: 'medium', reasons: [near(5)], notifications: call('failed', 1, 'WRONG_PERSON: the person who answered was not the farmer') }, 260, 250),
    alert({ id: 'alert_demo_09', ...plot(6), inspection_priority: 'high', reasons: [near(4)], notifications: call('failed', 0, 'NO_CONSENT') }, 300, 290),
    alert({ id: 'alert_demo_10', ...plot(1), inspection_priority: 'high', reasons: [near(3)], notifications: call('failed', 0, 'NOT_ALLOWLISTED') }, 330, 320),
    alert({ id: 'alert_demo_11', ...plot(2), inspection_priority: 'medium', reasons: [near(6)], notifications: call('unknown', 1, 'The call ended before the result was recorded') }, 400, 390),
    alert(
      { id: 'alert_demo_12', ...plot(7), inspection_priority: 'medium', reasons: [near(5)], status: 'cancelled',
        review_reason: 'Cancelled: the source case was closed before the call', notifications: call('cancelled', 0) },
      500, 495,
    ),
    alert(
      { id: 'alert_demo_13', ...plot(4), inspection_priority: 'low', reasons: ['Environmental similarity with an active case'],
        status: 'rejected', review_reason: 'Environmental similarity only, no exposure. No alert.' },
      90, 85,
    ),
  ]

  const followups: FollowUp[] = [
    {
      id: 'followup_demo_01', case_id: 'case_demo_01', plot_id: 'plot_demo_01', plot_label: 'Plot 1', due_at: ago(5),
      status: 'scheduled', channel: 'voice', attempt_count: 0, max_attempts: 3,
      case_summary: 'Yellow spots with orange powder; advised removing affected leaves.',
      status_reported: null, actions_taken: null, is_demo: true,
    },
    {
      id: 'followup_demo_02', case_id: 'case_demo_06', plot_id: 'plot_demo_06', plot_label: 'Plot 6', due_at: ago(1),
      status: 'contacting', channel: 'voice', attempt_count: 1, max_attempts: 3,
      case_summary: 'SMS report of spotted leaves; referred to an agronomist.',
      status_reported: null, actions_taken: null, is_demo: true,
    },
    {
      id: 'followup_demo_03', case_id: 'case_demo_06', plot_id: 'plot_demo_06', plot_label: 'Plot 6', due_at: inMin(180),
      status: 'scheduled', channel: 'voice', attempt_count: 0, max_attempts: 3,
      case_summary: 'Second follow-up scheduled after the agronomist review.',
      status_reported: null, actions_taken: null, is_demo: true,
    },
    {
      id: 'followup_demo_04', case_id: 'case_demo_01', plot_id: 'plot_demo_01', plot_label: 'Plot 1', due_at: ago(130),
      status: 'no_response', channel: 'sms', attempt_count: 3, max_attempts: 3,
      case_summary: 'First follow-up: three unanswered calls; a fallback SMS was sent.',
      status_reported: null, actions_taken: null, is_demo: true,
    },
    {
      id: 'followup_demo_05', case_id: 'case_demo_05', plot_id: 'plot_demo_05', plot_label: 'Plot 5', due_at: ago(720),
      status: 'responded', channel: 'voice', attempt_count: 1, max_attempts: 3,
      case_summary: 'Suspected rust in one section of the plot.',
      status_reported: 'resolved', actions_taken: 'Removed and buried the spotted leaves and regulated the shade.', is_demo: true,
    },
  ]

  const resolved: ResolvedCase[] = [
    {
      id: 'resolution_demo_01', case_id: 'case_demo_05', plot_id: 'plot_demo_05', plot_label: 'Plot 5',
      threat_code: 'coffee_leaf_rust', symptoms: ['yellow spots', 'orange powder on the underside'], resolved_at: ago(720),
      solution_statement: 'Removed and buried the affected leaves and regulated the shade.',
      solution_codes: ['remove_affected_leaves', 'regulate_shade'], matches_protocol: true, outcome: 'resolved',
      verification: 'farmer_reported', is_demo: true,
    },
    {
      id: 'resolution_demo_02', case_id: 'case_demo_04', plot_id: 'plot_demo_04', plot_label: 'Plot 4',
      threat_code: 'coffee_leaf_rust', symptoms: ['yellow spots'], resolved_at: ago(60 * 24 * 14),
      solution_statement: 'Pruned for ventilation and controlled weeds; checked by an agronomist on a visit.',
      solution_codes: ['ventilation_pruning', 'weed_control'], matches_protocol: true, outcome: 'resolved',
      verification: 'verified', is_demo: true,
    },
    {
      id: 'resolution_demo_03', case_id: 'case_demo_03', plot_id: 'plot_demo_03', plot_label: 'Plot 3',
      threat_code: 'coffee_leaf_rust', symptoms: ['orange powder on the underside', 'leaf drop'], resolved_at: ago(60 * 24 * 20),
      solution_statement: 'Applied a fungicide recommended at the store, at the dose the seller suggested.',
      solution_codes: null, matches_protocol: false, outcome: 'improved_enough', verification: 'farmer_reported', is_demo: true,
    },
  ]

  const timeline: Record<string, TimelineEntry[]> = {
    plot_demo_01: [
      {
        id: 'tl_01_5', kind: 'followup', occurred_at: ago(5), title: 'Follow-up overdue',
        detail: 'The follow-up call is waiting for its turn within allowed hours.',
      },
      {
        id: 'tl_01_4', kind: 'risk_change', occurred_at: ago(20), title: 'Priority changed to high (0.74)',
        detail: 'Model 1.0.0. Contributions: direct reports +0.31, humidity +0.12.',
      },
      {
        id: 'tl_01_3', kind: 'assessment', occurred_at: ago(21), title: 'The advisor gave guidance',
        detail: 'Suspected coffee leaf rust (unconfirmed).', disposition: 'advise',
        recommendations: [
          { code: 'remove_affected_leaves', text: 'Remove spotted leaves and bury them outside the plot', protocol_id: 'coffee-rust-demo-v1' },
          { code: 'regulate_shade', text: 'Regulate the shade so air can circulate', protocol_id: 'coffee-rust-demo-v1' },
        ],
        resolved_case_mentions: [
          {
            resolution_id: 'resolution_demo_01',
            summary_for_speech: 'A similar plot nearby improved after removing affected leaves and regulating the shade.',
            verification: 'farmer_reported',
          },
        ],
      },
      {
        id: 'tl_01_2', kind: 'assessment', occurred_at: ago(23), title: 'The advisor checked data before asking',
        detail: 'Only asked the farmer about the underside of the leaves.', disposition: 'ask_more',
        data_used: [
          { query_id: 'q_demo_01', summary: '14-day mean humidity above normal (82 % vs 68 %)', data_freshness: 'fresh', dataset_ids: ['dataset_humidity_demo'] },
          { query_id: 'q_demo_02', summary: '14-day rainfall 2.3 times normal', data_freshness: 'fresh', dataset_ids: ['dataset_rain_demo'] },
        ],
      },
      {
        id: 'tl_01_1', kind: 'report', occurred_at: ago(25), title: 'Report by phone call', channel: 'voice',
        detail: '"Since yesterday I see spots on several plants."',
      },
    ],
    plot_demo_06: [
      {
        id: 'tl_06_2', kind: 'assessment', occurred_at: ago(48), title: 'Referred to an agronomist',
        detail: 'The farmer asked about a fungicide; the protocol does not allow recommending products.',
        disposition: 'refer', human_review_required: true,
      },
      {
        id: 'tl_06_1', kind: 'report', occurred_at: ago(50), title: 'Report by SMS', channel: 'sms',
        detail: '"Leaves with brown spots and powder, what should I spray?"',
      },
    ],
    plot_demo_05: [
      {
        id: 'tl_05_2', kind: 'resolution', occurred_at: ago(720), title: 'Case resolved according to the farmer',
        detail: 'Removed and buried spotted leaves and regulated the shade. Verification: reported by the farmer.',
      },
      {
        id: 'tl_05_1', kind: 'report', occurred_at: ago(60 * 24 * 12), title: 'Report by phone call', channel: 'voice',
        detail: '"One section has yellow leaves."',
      },
    ],
  }

  return { alerts, followups, resolved, timeline }
}
