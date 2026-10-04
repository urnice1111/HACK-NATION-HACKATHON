import type { DashboardApi } from './client'
import { httpAdapter } from './httpAdapter'
import { mockAdapter } from './mockAdapter'

// VITE_API_MODE=mock (default) uses fixtures; VITE_API_MODE=http uses the backend.
export const API_MODE: 'mock' | 'http' = import.meta.env.VITE_API_MODE === 'http' ? 'http' : 'mock'

export const api: DashboardApi = API_MODE === 'http' ? httpAdapter : mockAdapter
