import type { AlertStatus, FollowUpStatus, NotificationStatus, StatusReported, Verification } from '../api/types'
import type { Tone } from '../components/Badge'

export const ALERT_STATUS: Record<AlertStatus, { label: string; tone: Tone }> = {
  pending_review: { label: 'Por revisar', tone: 'medium' },
  approved: { label: 'Aprobada', tone: 'accent' },
  queued: { label: 'Aprobada', tone: 'accent' },
  rejected: { label: 'Rechazada', tone: 'neutral' },
  cancelled: { label: 'Cancelada', tone: 'neutral' },
}

// "delivered" significa que el proveedor confirmó la entrega, no que el agricultor lo leyó.
export const DELIVERY: Record<NotificationStatus, { label: string; tone: Tone }> = {
  queued: { label: 'En cola', tone: 'neutral' },
  sending: { label: 'Enviando', tone: 'neutral' },
  accepted: { label: 'Aceptado por el proveedor', tone: 'low' },
  delivered: { label: 'Entregado (no implica leído)', tone: 'accent' },
  failed: { label: 'Falló el envío', tone: 'high' },
  unknown: { label: 'Estado incierto, por conciliar', tone: 'medium' },
  cancelled: { label: 'Envío cancelado', tone: 'neutral' },
}

export const FOLLOWUP_STATUS: Record<FollowUpStatus, string> = {
  scheduled: 'Programado',
  contacting: 'En curso',
  responded: 'Respondido',
  no_response: 'Sin respuesta',
  failed: 'Falló',
  cancelled: 'Cancelado',
}

export const STATUS_REPORTED: Record<StatusReported, string> = {
  worse: 'Empeoró',
  same: 'Sigue igual',
  improved: 'Mejoró',
  resolved: 'Resuelto',
  unknown: 'No sabe',
}

export const VERIFICATION: Record<Verification, { label: string; tone: Tone }> = {
  verified: { label: 'Verificado por agrónomo', tone: 'accent' },
  farmer_reported: { label: 'Reportado por el agricultor', tone: 'low' },
  disputed: { label: 'En disputa', tone: 'medium' },
}
