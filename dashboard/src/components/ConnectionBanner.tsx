import type { UseQueryResult } from '@tanstack/react-query'
import { RefreshCw, WifiOff } from 'lucide-react'
import { formatTime } from '../lib/format'

// Si falla la consulta pero ya había datos, se conservan y se marca que están desactualizados.
export function ConnectionBanner({ query }: { query: UseQueryResult<unknown, Error> }) {
  if (!query.isError || query.data === undefined) return null
  return (
    <div role="alert" className="flex animate-fade-in items-center gap-3 rounded-full border border-prio-medium/40 bg-panel/90 py-1.5 pr-1.5 pl-4 text-sm text-prio-medium shadow-float backdrop-blur-md">
      <WifiOff size={15} />
      <span>Sin conexión. Mostrando datos de las {formatTime(query.dataUpdatedAt)}</span>
      <button
        onClick={() => void query.refetch()}
        className="flex items-center gap-1.5 rounded-full border border-prio-medium/40 px-3 py-0.5 transition-colors hover:bg-prio-medium/10"
      >
        <RefreshCw size={13} className={query.isFetching ? 'animate-spin' : ''} />
        {query.isFetching ? 'Reintentando…' : 'Reintentar'}
      </button>
    </div>
  )
}
