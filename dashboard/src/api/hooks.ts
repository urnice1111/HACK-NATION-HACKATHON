import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './index'
import type { AlertReview } from './types'

// The spec allows polling every 5 s (INSTRUCTIONS.md §2); no real time needed.
const POLL_MS = 5000
export const THREAT_CODE = 'coffee_leaf_rust'

export const useGraph = () =>
  useQuery({ queryKey: ['graph', THREAT_CODE], queryFn: () => api.getGraph(THREAT_CODE), refetchInterval: POLL_MS })

export const useTimeline = (plotId: string | undefined) =>
  useQuery({
    queryKey: ['timeline', plotId],
    queryFn: () => api.getTimeline(plotId as string),
    enabled: Boolean(plotId),
    refetchInterval: POLL_MS,
  })

export const useAlerts = () =>
  useQuery({ queryKey: ['alerts'], queryFn: () => api.getAlerts(), refetchInterval: POLL_MS })

export const useAlert = (id: string | undefined) =>
  useQuery({
    queryKey: ['alert', id],
    queryFn: () => api.getAlert(id as string),
    enabled: Boolean(id),
    refetchInterval: POLL_MS,
  })

export const useFollowups = () =>
  useQuery({ queryKey: ['followups'], queryFn: () => api.getFollowups(), refetchInterval: POLL_MS })

export const useResolvedCases = () =>
  useQuery({ queryKey: ['resolved-cases'], queryFn: () => api.getResolvedCases(), refetchInterval: POLL_MS })

export function useReviewAlert() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: AlertReview }) => api.reviewAlert(id, body),
    // On success or 409, reload so the screen shows the server's real state.
    onSettled: (_data, _error, { id }) => {
      void qc.invalidateQueries({ queryKey: ['alerts'] })
      void qc.invalidateQueries({ queryKey: ['alert', id] })
      void qc.invalidateQueries({ queryKey: ['graph'] })
    },
  })
}

export function useResetDemo() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.resetDemo(),
    onSuccess: () => qc.invalidateQueries(),
  })
}
