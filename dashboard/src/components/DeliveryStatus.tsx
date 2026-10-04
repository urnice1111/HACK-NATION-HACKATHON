import { MessageSquare, Phone } from 'lucide-react'
import type { Alert } from '../api/types'
import { deliveryLabel } from '../lib/labels'
import { Badge } from './Badge'

// Delivery outcome of an approved alert, one row per notification. The parent query polls
// every 5 s, so the badge walks queued → calling → in progress → confirmed on its own.
export function DeliveryStatus({ alert }: { alert: Alert }) {
  if (alert.status === 'pending_review' || alert.status === 'rejected') return null
  if (alert.notifications.length === 0) {
    if (alert.status === 'cancelled') return null
    return <p className="text-xs text-ink-muted" aria-live="polite">No call queued yet.</p>
  }
  return (
    <ul className="space-y-1.5" aria-live="polite">
      {alert.notifications.map((n) => {
        const d = deliveryLabel(n)
        return (
          <li key={n.notification_id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="flex items-center gap-1 text-xs text-ink-muted">
              {n.channel === 'voice' ? <><Phone size={12} />Call</> : <><MessageSquare size={12} />SMS</>}
            </span>
            <Badge tone={d.tone}>{d.label}</Badge>
            {d.detail && (
              <span className={`text-xs ${n.status === 'failed' ? 'text-prio-high' : 'text-ink-muted'}`}>{d.detail}</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}
