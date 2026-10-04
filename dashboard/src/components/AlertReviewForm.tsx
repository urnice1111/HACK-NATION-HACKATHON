import { useState } from 'react'
import { Check, Loader2, Phone, X } from 'lucide-react'
import { ApiError } from '../api/client'
import { useReviewAlert } from '../api/hooks'
import type { Alert } from '../api/types'
import { reviewConflictMessage } from '../lib/labels'

type Props = {
  alert: Alert
  // A 409 refetches the alert and usually moves it out of "pending", which unmounts this
  // form; the parent keeps the message so the operator still sees why.
  onConflict: (message: string) => void
}

export function AlertReviewForm({ alert, onConflict }: Props) {
  const review = useReviewAlert()
  const [message, setMessage] = useState(alert.message)
  const [reason, setReason] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const submit = (decision: 'approve' | 'reject') => {
    // isPending blocks double clicks: an alert is only sent once.
    if (review.isPending) return
    if (decision === 'approve' && !message.trim()) return setFormError('The message cannot be empty.')
    if (decision === 'reject' && !reason.trim()) return setFormError('Write the reason for rejecting.')
    setFormError(null)
    review.mutate(
      {
        id: alert.id,
        body: { decision, expected_version: alert.version, reason: reason.trim() || 'Preventive alert reviewed', message: message.trim() },
      },
      {
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409) onConflict(reviewConflictMessage(err.code, err.message))
        },
      },
    )
  }

  const conflict = review.error instanceof ApiError && review.error.status === 409

  return (
    <div className="space-y-3">
      <label className="block space-y-1 text-sm">
        <span className="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
          <Phone size={13} />What the alert call will say to {alert.recipient_label}
        </span>
        <textarea
          value={message}
          onChange={(e) => { setMessage(e.target.value); setFormError(null) }}
          rows={3}
          className="field resize-y"
        />
      </label>
      <label className="block space-y-1 text-sm">
        <span className="text-xs font-medium text-ink-muted">Reason (required to reject)</span>
        <input
          value={reason}
          onChange={(e) => { setReason(e.target.value); setFormError(null) }}
          className="field"
          placeholder="Environmental similarity only, no exposure"
        />
      </label>

      {formError && <p role="alert" className="text-sm text-prio-high">{formError}</p>}
      {review.isError && !conflict && (
        <p role="alert" className="text-sm text-prio-high">The review could not be saved. {review.error.message}</p>
      )}

      <div className="flex gap-2">
        <button onClick={() => submit('approve')} disabled={review.isPending} className="btn-primary flex-1">
          {review.isPending ? <><Loader2 size={15} className="animate-spin" />Saving…</> : <><Check size={15} />Approve and call</>}
        </button>
        <button
          onClick={() => submit('reject')}
          disabled={review.isPending}
          className="btn-ghost hover:border-prio-high/40 hover:text-prio-high"
        >
          <X size={15} />Reject
        </button>
      </div>
    </div>
  )
}

export function ConflictNotice({ message }: { message: string }) {
  return (
    <p role="alert" className="rounded-md border border-prio-medium/30 bg-prio-medium/10 p-2.5 text-sm text-prio-medium">
      {message}
    </p>
  )
}
