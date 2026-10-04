import { useState } from 'react'
import { BellRing, PhoneCall } from 'lucide-react'
import { Link, useParams } from 'react-router'
import { useAlert } from '../api/hooks'
import { AlertReviewForm, ConflictNotice } from '../components/AlertReviewForm'
import { Badge } from '../components/Badge'
import { DeliveryStatus } from '../components/DeliveryStatus'
import { Panel } from '../components/Panel'
import { QueryBoundary } from '../components/QueryBoundary'
import { formatDate, formatRelative } from '../lib/format'
import { ALERT_STATUS } from '../lib/labels'
import { PRIORITY } from '../lib/priority'

// GET /v1/alerts/{id}, polled every 5 s so the call outcome updates while the operator watches.
export function AlertDetailPage() {
  const { alertId } = useParams()
  const alert = useAlert(alertId)
  const [notice, setNotice] = useState<string | null>(null)

  return (
    <Panel title="Alert" icon={<BellRing size={18} />} wide>
      <QueryBoundary query={alert} empty="This alert does not exist.">
        {(a) => {
          const status = ALERT_STATUS[a.status]
          const prio = PRIORITY[a.inspection_priority]
          return (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link to={`/plot/${a.plot_id}`} className="plot-link">{a.plot_label}</Link>
                <div className="flex flex-wrap gap-1.5">
                  <Badge tone={a.inspection_priority === 'unknown' ? 'unknown' : a.inspection_priority}>{prio.label}</Badge>
                  <Badge tone={status.tone}>{status.label}</Badge>
                </div>
              </div>

              <section>
                <h3 className="section-title mb-2">Why it was proposed</h3>
                <ul className="space-y-1 text-sm text-ink-muted">
                  {a.reasons.map((r) => (
                    <li key={r} className="flex gap-2"><span className="mt-2 size-1 shrink-0 rounded-full bg-ink-muted" />{r}</li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-ink-muted">Proposed {formatRelative(a.created_at)} · recipient: {a.recipient_label}</p>
              </section>

              {notice && <ConflictNotice message={notice} />}

              {a.status === 'pending_review' ? (
                <AlertReviewForm alert={a} onConflict={setNotice} />
              ) : (
                <>
                  <section>
                    <h3 className="section-title mb-2 flex items-center gap-1.5"><PhoneCall size={13} />Delivery</h3>
                    {a.status === 'rejected' ? (
                      <p className="text-sm text-ink-muted">Rejected: nobody is called.</p>
                    ) : (
                      <DeliveryStatus alert={a} />
                    )}
                  </section>
                  {a.message && (
                    <section>
                      <h3 className="section-title mb-2">Message</h3>
                      <p className="rounded-md bg-bg/50 px-2.5 py-1.5 text-sm">{a.message}</p>
                    </section>
                  )}
                  <p className="text-xs text-ink-muted">
                    Reviewed by {a.approved_by ?? 'nobody yet'}{a.approved_at ? `, ${formatDate(a.approved_at)}` : ''}
                    {a.review_reason ? ` · ${a.review_reason}` : ''}
                  </p>
                </>
              )}
            </div>
          )
        }}
      </QueryBoundary>
    </Panel>
  )
}
