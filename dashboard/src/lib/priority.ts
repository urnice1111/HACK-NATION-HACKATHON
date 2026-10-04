import type { DataFreshness, InspectionPriority, LocalCaseStatus } from '../api/types'

export const PRIORITY: Record<InspectionPriority, { label: string; color: string }> = {
  unknown: { label: 'No data', color: '#6B7280' },
  low: { label: 'Low', color: '#60A5FA' },
  medium: { label: 'Medium', color: '#F5B83D' },
  high: { label: 'High', color: '#F2675A' },
}

export const CASE_STATUS: Record<LocalCaseStatus, string> = {
  none: 'No case',
  reported: 'Reported',
  suspected: 'Suspected',
  confirmed: 'Confirmed',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
}

export const FRESHNESS: Record<DataFreshness, string> = {
  fresh: 'Recent data',
  stale: 'Out-of-date data',
  unknown: 'Unknown freshness',
}

export const FEATURE_LABELS: Record<string, string> = {
  direct_active_reports: 'Active direct reports',
  neighbor_source_exposure: 'Exposure to neighboring cases',
  humidity_mean_14d: 'Mean humidity, 14 days',
  rain_anomaly_30d: 'Rain anomaly, 30 days',
  temp_optimal_days_14d: 'Days at 21–25 °C (14 days)',
}

export const hasDirectCase = (s: LocalCaseStatus) => s !== 'none' && s !== 'resolved'
