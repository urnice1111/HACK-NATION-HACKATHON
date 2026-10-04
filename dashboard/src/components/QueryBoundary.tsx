import type { ReactNode } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import { AlertTriangle, Inbox, RefreshCw } from 'lucide-react'

type Props<T> = {
  query: UseQueryResult<T, Error>
  isEmpty?: (data: T) => boolean
  empty: ReactNode
  children: (data: T) => ReactNode
}

// Estados de carga, error y vacío en un solo lugar. Si hay datos previos y falla
// la consulta, se siguen mostrando (el aviso global indica que están desactualizados).
export function QueryBoundary<T>({ query, isEmpty, empty, children }: Props<T>) {
  if (query.data !== undefined) {
    if (isEmpty?.(query.data)) {
      return (
        <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-ink-muted">
          <span className="grid size-11 place-items-center rounded-full bg-panel-2 ring-1 ring-line"><Inbox size={20} /></span>
          <p className="max-w-60">{empty}</p>
        </div>
      )
    }
    return <div className="animate-fade-in">{children(query.data)}</div>
  }
  if (query.isPending) {
    return (
      <div className="space-y-2.5 py-1" aria-busy="true" aria-label="Cargando">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-2 rounded-lg border border-line/60 p-3">
            <div className="h-3.5 w-1/3 animate-pulse rounded bg-panel-2" />
            <div className="h-3 w-full animate-pulse rounded bg-panel-2/70" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-panel-2/70" />
          </div>
        ))}
      </div>
    )
  }
  return (
    <div role="alert" className="flex flex-col items-center gap-2 py-10 text-center text-sm">
      <span className="grid size-11 place-items-center rounded-full bg-prio-high/10 text-prio-high ring-1 ring-prio-high/30"><AlertTriangle size={20} /></span>
      <p className="font-medium text-prio-high">No se pudieron cargar los datos.</p>
      <p className="text-ink-muted">{query.error?.message}</p>
      <button onClick={() => void query.refetch()} className="btn-ghost mt-2">
        <RefreshCw size={14} />Reintentar
      </button>
    </div>
  )
}
