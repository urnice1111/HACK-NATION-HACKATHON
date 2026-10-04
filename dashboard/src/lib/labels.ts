import type {
  AlertNotification, AlertStatus, FollowUpStatus, StatusReported, Verification,
} from '../api/types'
import type { Tone } from '../components/Badge'

export const ALERT_STATUS: Record<AlertStatus, { label: string; tone: Tone }> = {
  pending_review: { label: 'Pending review', tone: 'medium' },
  approved: { label: 'Approved', tone: 'accent' },
  queued: { label: 'Approved', tone: 'accent' },
  rejected: { label: 'Rejected', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
}

// Reason codes communications writes at the start of last_error when a notification fails.
const FAILURE_REASON: Record<string, string> = {
  NO_ANSWER: 'no answer after 3 attempts',
  WRONG_PERSON: 'someone else answered',
  NO_CONSENT: 'no consent for alerts',
  NOT_ALLOWLISTED: 'number not on the demo allowlist',
}

export function failureReason(lastError: string | null): string | null {
  if (!lastError) return null
  const code = /^[A-Z_]+/.exec(lastError.trim())?.[0]
  return (code && FAILURE_REASON[code]) ?? lastError
}

// Delivery outcome as the operator should read it. Alerts go out as a voice call from the
// "Alerts" agent; "delivered" only means the farmer confirmed they heard it, never that they
// acted on it (INSTRUCTIONS.md §11). SMS keeps provider wording in case the backend still
// queues one.
export function deliveryLabel(n: AlertNotification): { label: string; tone: Tone; detail: string | null } {
  const voice = n.channel === 'voice'
  switch (n.status) {
    case 'queued':
      return { label: 'Queued', tone: 'neutral', detail: null }
    case 'sending':
      return {
        label: voice ? `Calling (attempt ${Math.max(n.attempt_count, 1)})` : 'Sending SMS',
        tone: 'low',
        detail: null,
      }
    case 'accepted':
      return { label: voice ? 'Call in progress' : 'Accepted by the carrier', tone: 'low', detail: null }
    case 'delivered':
      return {
        label: voice ? 'Farmer confirmed they heard the alert' : 'SMS delivered (not necessarily read)',
        tone: 'accent',
        detail: null,
      }
    case 'failed':
      return { label: 'Could not notify', tone: 'high', detail: failureReason(n.last_error) ?? 'reason not reported' }
    case 'unknown':
      return { label: 'Unconfirmed', tone: 'medium', detail: n.last_error }
    case 'cancelled':
      return { label: 'Cancelled', tone: 'neutral', detail: null }
  }
}

// Clear wording for a 409 on POST /v1/alerts/{id}/review, by backend error code.
export function reviewConflictMessage(code: string, serverMessage: string): string {
  switch (code) {
    case 'ALERT_ALREADY_REVIEWED':
    case 'ALERT_NOT_PENDING':
      return 'Another operator already reviewed this alert. It now shows its current state.'
    case 'VERSION_CONFLICT':
      return 'This alert changed since you opened it, probably reviewed by another operator. Check its current state before trying again.'
    case 'EVIDENCE_CHANGED':
      return 'The evidence changed: this plot is no longer medium or high priority, so the alert cannot be approved.'
    case 'NO_CONSENT':
      return 'The farmer has not consented to alerts, so this alert cannot be sent.'
    default:
      return `This alert could not be reviewed: ${serverMessage}`
  }
}

export const FOLLOWUP_STATUS: Record<FollowUpStatus, string> = {
  scheduled: 'Scheduled',
  contacting: 'In progress',
  responded: 'Responded',
  no_response: 'No response',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export const STATUS_REPORTED: Record<StatusReported, string> = {
  worse: 'Worse',
  same: 'Same',
  improved: 'Improved',
  resolved: 'Resolved',
  unknown: "Doesn't know",
}

export const VERIFICATION: Record<Verification, { label: string; tone: Tone }> = {
  verified: { label: 'Verified by an agronomist', tone: 'accent' },
  farmer_reported: { label: 'Reported by the farmer', tone: 'low' },
  disputed: { label: 'Disputed', tone: 'medium' },
}
