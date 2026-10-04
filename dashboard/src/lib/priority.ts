import type { DataFreshness, InspectionPriority, LocalCaseStatus } from '../api/types'

export const PRIORITY: Record<InspectionPriority, { label: string; color: string }> = {
  unknown: { label: 'Sin datos', color: '#6B7280' },
  low: { label: 'Baja', color: '#60A5FA' },
  medium: { label: 'Media', color: '#F5B83D' },
  high: { label: 'Alta', color: '#F2675A' },
}

export const CASE_STATUS: Record<LocalCaseStatus, string> = {
  none: 'Sin caso',
  reported: 'Reportado',
  suspected: 'Sospechoso',
  confirmed: 'Confirmado',
  monitoring: 'En monitoreo',
  resolved: 'Resuelto',
}

export const FRESHNESS: Record<DataFreshness, string> = {
  fresh: 'Datos recientes',
  stale: 'Datos desactualizados',
  unknown: 'Frescura desconocida',
}

export const FEATURE_LABELS: Record<string, string> = {
  direct_active_reports: 'Reportes directos activos',
  neighbor_source_exposure: 'Exposición a casos vecinos',
  humidity_mean_14d: 'Humedad media 14 días',
  rain_anomaly_30d: 'Anomalía de lluvia 30 días',
  temp_optimal_days_14d: 'Días con 21–25 °C (14 días)',
}

export const hasDirectCase = (s: LocalCaseStatus) => s !== 'none' && s !== 'resolved'
