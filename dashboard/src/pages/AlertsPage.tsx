import { useState } from 'react'
import { BellRing, ChevronRight, Clock } from 'lucide-react'
import { Link } from 'react-router'
import { useAlerts } from '../api/hooks'
import type { Alert } from '../api/types'
import { AlertReviewForm, ConflictNotice } from '../components/AlertReviewForm'
import { Badge } from '../components/Badge'
import { DeliveryStatus } from '../components/DeliveryStatus'
import { Panel } from '../components/Panel'
import { QueryBoundary } from '../components/QueryBoundary'
import { formatDate, formatRelative } from '../lib/format'
import { ALERT_STATUS } from '../lib/labels'
import { PRIORITY } from '../lib/priority'

type ItemProps = { alert: Alert; notice?: string; onConflict: (message: string) => void }

function PendingAlert({ alert, notice, onConflict }: ItemProps) {
  const prio = PRIORITY[alert.inspection_priority]
  return (
    <li className="card space-y-3 border-l-[3px] p-4" style={{ borderLeftColor: prio.color }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to={`/plot/${alert.plot_id}`} className="plot-link">{alert.plot_label}</Link>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1 text-xs text-ink-muted"><Clock size={12} />{formatRelative(alert.created_at)}</span>
          <Badge tone={alert.inspection_priority === 'unknown' ? 'unknown' : alert.inspection_priority}>{prio.label}</Badge>
        </div>
      </div>

      <ul className="space-y-1 text-sm text-ink-muted">
        {alert.reasons.map((r) => (
          <li key={r} className="flex gap-2"><span className="mt-2 size-1 shrink-0 rounded-full bg-ink-muted" />{r}</li>
        ))}
      </ul>

      {notice && <ConflictNotice message={notice} />}
      <AlertReviewForm alert={alert} onConflict={onConflict} />
    </li>
  )
}

function ReviewedAlert({ alert, notice }: { alert: Alert; notice?: string }) {
  const status = ALERT_STATUS[alert.status]
  return (
    <li className="space-y-1.5 border-b border-line/70 py-3 last:border-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to={`/plot/${alert.plot_id}`} className="plot-link">{alert.plot_label}</Link>
        <div className="flex items-center gap-1.5">
          <Badge tone={status.tone}>{status.label}</Badge>
          <Link
            to={`/alerts/${alert.id}`}
            aria-label={`Alert details for ${alert.plot_label}`}
            className="flex items-center text-xs text-ink-muted hover:text-ink"
          >
            Details<ChevronRight size={14} />
          </Link>
        </div>
      </div>
      {notice && <ConflictNotice message={notice} />}
      <DeliveryStatus alert={alert} />
      {alert.review_reason && <p className="text-sm text-ink-muted">{alert.review_reason}</p>}
      <p className="text-xs text-ink-muted">
        {alert.approved_by ?? 'No reviewer'}{alert.approved_at ? `, ${formatDate(alert.approved_at)}` : ''}
      </p>
    </li>
  )
}

export function AlertsPage() {
  const alerts = useAlerts()
  // 409 messages by alert id; they outlive the form, which unmounts once the alert is reviewed.
  const [notices, setNotices] = useState<Record<string, string>>({})
  const noticeFor = (id: string) => (message: string) => setNotices((prev) => ({ ...prev, [id]: message }))

  return (
    <Panel title="Alerts" subtitle="A person decides before any farmer is called" icon={<BellRing size={18} />} wide>
      <QueryBoundary query={alerts} isEmpty={(d) => d.items.length === 0} empty="No alerts proposed yet.">
        {(d) => {
          const pending = d.items.filter((a) => a.status === 'pending_review')
          const reviewed = d.items.filter((a) => a.status !== 'pending_review')
          return (
            <div className="space-y-5">
              <section>
                <h3 className="section-title mb-3 flex items-center gap-2">To review<span className="rounded-full bg-prio-medium/15 px-1.5 text-prio-medium">{pending.length}</span></h3>
                {pending.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-line px-4 py-5 text-center text-sm text-ink-muted">No pending alerts. New proposals will show up here.</p>
                ) : (
                  <ul className="space-y-3">
                    {pending.map((a) => <PendingAlert key={a.id} alert={a} notice={notices[a.id]} onConflict={noticeFor(a.id)} />)}
                  </ul>
                )}
              </section>
              {reviewed.length > 0 && (
                <section>
                  <h3 className="section-title mb-1">Reviewed</h3>
                  <ul>{reviewed.map((a) => <ReviewedAlert key={a.id} alert={a} notice={notices[a.id]} />)}</ul>
                </section>
              )}
            </div>
          )
        }}
      </QueryBoundary>
    </Panel>
  )
}
