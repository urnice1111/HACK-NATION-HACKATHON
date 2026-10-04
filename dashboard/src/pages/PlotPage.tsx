import { Bell, ClipboardList, FileText, Leaf, PhoneCall, Stethoscope, TrendingUp, type LucideIcon } from 'lucide-react'
import { useParams } from 'react-router'
import { useGraph, useTimeline } from '../api/hooks'
import type { GraphNode, TimelineEntry } from '../api/types'
import { Badge } from '../components/Badge'
import { Panel } from '../components/Panel'
import { QueryBoundary } from '../components/QueryBoundary'
import { formatRelative } from '../lib/format'
import { CASE_STATUS, FEATURE_LABELS, FRESHNESS, PRIORITY, hasDirectCase } from '../lib/priority'
import { VERIFICATION } from '../lib/labels'

// Explains where the priority comes from: own report, neighbors or weather only.
function origin(node: GraphNode) {
  if (hasDirectCase(node.local_case_status)) return 'Direct report on this plot'
  if (node.contributions.some((c) => c.feature === 'neighbor_source_exposure')) return 'Exposure to neighboring plots with an active case'
  if (node.inspection_priority === 'unknown') return 'Not enough evidence to compute'
  return 'Environmental conditions'
}

const KIND: Record<TimelineEntry['kind'], { label: string; icon: LucideIcon; cls: string }> = {
  report: { label: 'Report', icon: FileText, cls: 'text-prio-high bg-prio-high/10 ring-prio-high/30' },
  assessment: { label: 'Advisor', icon: Stethoscope, cls: 'text-prio-low bg-prio-low/10 ring-prio-low/30' },
  risk_change: { label: 'Priority', icon: TrendingUp, cls: 'text-prio-medium bg-prio-medium/10 ring-prio-medium/30' },
  alert: { label: 'Alert', icon: Bell, cls: 'text-prio-medium bg-prio-medium/10 ring-prio-medium/30' },
  followup: { label: 'Follow-up', icon: PhoneCall, cls: 'text-ink-muted bg-panel-2 ring-line' },
  resolution: { label: 'Resolution', icon: Leaf, cls: 'text-accent bg-accent/10 ring-accent/30' },
}

function TimelineItem({ entry }: { entry: TimelineEntry }) {
  const kind = KIND[entry.kind]
  const Icon = kind.icon
  return (
    <li className="relative pb-5 pl-10 last:pb-0 [&:last-child>.rail]:hidden">
      <span className="rail absolute top-7 bottom-0 left-[13px] w-px bg-line" />
      <span className={`absolute top-0 left-0 grid size-7 place-items-center rounded-full ring-1 ${kind.cls}`}><Icon size={14} /></span>
      <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-ink-muted">
        <span className="font-semibold text-ink">{kind.label}</span>
        <span>· {formatRelative(entry.occurred_at)}</span>
        {entry.human_review_required && <Badge tone="medium">Needs human review</Badge>}
      </div>
      <p className="mt-0.5 text-sm font-medium">{entry.title}</p>
      {entry.detail && <p className="text-sm text-ink-muted">{entry.detail}</p>}

      {entry.data_used && entry.data_used.length > 0 && (
        <div className="mt-2 rounded-lg border border-line bg-bg/50 p-2.5">
          <p className="section-title mb-1.5">Environmental data it checked</p>
          <ul className="space-y-1 text-sm">
            {entry.data_used.map((d) => (
              <li key={d.query_id} className="flex justify-between gap-2">
                <span>{d.summary}</span>
                {d.data_freshness !== 'fresh' && <Badge tone="medium">{FRESHNESS[d.data_freshness]}</Badge>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {entry.recommendations && entry.recommendations.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-4 text-sm">
          {entry.recommendations.map((r) => (
            <li key={r.code}>{r.text} <span className="text-xs text-ink-muted">({r.protocol_id})</span></li>
          ))}
        </ul>
      )}

      {entry.resolved_case_mentions?.map((m) => (
        <div key={m.resolution_id} className="mt-2 rounded-lg border border-accent/20 bg-accent/5 p-2.5 text-sm">
          <p className="section-title mb-1.5">Resolved case it mentioned</p>
          <p>{m.summary_for_speech}</p>
          <div className="mt-1"><Badge tone={VERIFICATION[m.verification].tone}>{VERIFICATION[m.verification].label}</Badge></div>
        </div>
      ))}
    </li>
  )
}

export function PlotPage() {
  const { plotId } = useParams()
  const graph = useGraph()
  const timeline = useTimeline(plotId)
  const node = graph.data?.nodes.find((n) => n.id === plotId)

  if (!node) {
    return (
      <Panel title="Plot" icon={<Leaf size={18} />}>
        <p className="py-6 text-center text-sm text-ink-muted">
          {graph.isPending ? 'Loading plot…' : 'This plot is not in the current graph.'}
        </p>
      </Panel>
    )
  }

  const prio = PRIORITY[node.inspection_priority]
  const maxContribution = Math.max(...node.contributions.map((c) => Math.abs(c.value)), 0.01)

  return (
    <Panel title={node.label} subtitle={CASE_STATUS[node.local_case_status]} icon={<Leaf size={18} />}>
      <div className="space-y-5">
        {/* Priority card: color, score and where it comes from. */}
        <div
          className="relative overflow-hidden rounded-xl border p-4"
          style={{ borderColor: `${prio.color}55`, background: `linear-gradient(135deg, ${prio.color}22, transparent 70%)` }}
        >
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="section-title">Inspection priority</p>
              <p className="mt-1 text-2xl font-bold" style={{ color: prio.color }}>{prio.label}</p>
            </div>
            <div className="text-right">
              <p className="section-title">Score</p>
              <p className="mt-1 text-2xl font-bold">{node.score === null ? '—' : node.score.toFixed(2)}</p>
            </div>
          </div>
          {node.score !== null && (
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-bg/60">
              <div className="h-full rounded-full" style={{ width: `${Math.min(node.score, 1) * 100}%`, background: prio.color }} />
            </div>
          )}
          <p className="mt-3 text-sm"><span className="text-ink-muted">Source: </span>{origin(node)}</p>
        </div>

        {node.heuristic && (
          <p className="rounded-lg border border-prio-medium/30 bg-prio-medium/10 px-3 py-2 text-xs text-prio-medium">
            Heuristic priority: it guides inspection, it is not a validated probability of spread.
          </p>
        )}

        <section>
          <h3 className="section-title mb-2">Reasons</h3>
          <ul className="space-y-1.5 text-sm">
            {node.reasons.map((r) => (
              <li key={r} className="flex gap-2"><span className="mt-1.5 size-1.5 shrink-0 rounded-full" style={{ background: prio.color }} />{r}</li>
            ))}
          </ul>
        </section>

        {node.contributions.length > 0 && (
          <section>
            <h3 className="section-title mb-2">Top model contributions</h3>
            <ul className="space-y-2.5 text-sm">
              {node.contributions.map((c) => (
                <li key={c.feature}>
                  <div className="flex justify-between gap-2">
                    <span>{FEATURE_LABELS[c.feature] ?? c.feature}</span>
                    <span className={`font-semibold ${c.value >= 0 ? 'text-prio-high' : 'text-prio-low'}`}>{c.value >= 0 ? '+' : ''}{c.value.toFixed(2)}</span>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-line">
                    <div
                      className={`h-full rounded-full ${c.value >= 0 ? 'bg-prio-high' : 'bg-prio-low'}`}
                      style={{ width: `${(Math.abs(c.value) / maxContribution) * 100}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <dl className="grid grid-cols-3 gap-2 text-xs">
          <div className="rounded-lg border border-line bg-bg/40 p-2.5">
            <dt className="text-ink-muted">Freshness</dt>
            <dd className={`mt-1 font-medium ${node.data_freshness === 'fresh' ? 'text-accent' : 'text-prio-medium'}`}>{FRESHNESS[node.data_freshness]}</dd>
          </div>
          <div className="rounded-lg border border-line bg-bg/40 p-2.5">
            <dt className="text-ink-muted">Model</dt>
            <dd className="mt-1 truncate font-medium">{node.model_version ?? 'No model'}</dd>
          </div>
          <div className="rounded-lg border border-line bg-bg/40 p-2.5">
            <dt className="text-ink-muted">Evidence</dt>
            <dd className="mt-1 font-medium">{node.evidence_report_ids.length} reports</dd>
          </div>
        </dl>

        <section>
          <h3 className="section-title mb-3 flex items-center gap-1.5"><ClipboardList size={13} />History</h3>
          <QueryBoundary
            query={timeline}
            isEmpty={(d) => d.items.length === 0}
            empty="This plot has no reports or assessments yet."
          >
            {(d) => <ol>{d.items.map((e) => <TimelineItem key={e.id} entry={e} />)}</ol>}
          </QueryBoundary>
        </section>
      </div>
    </Panel>
  )
}
