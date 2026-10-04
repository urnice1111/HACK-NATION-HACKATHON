import { useMemo, useState } from 'react'
import { FlaskConical, Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
import { Outlet, useMatch, useNavigate } from 'react-router'
import { useGraph } from '../api/hooks'
import type { GraphResponse, InspectionPriority } from '../api/types'
import { ConnectionBanner } from '../components/ConnectionBanner'
import { Filters } from '../components/Filters'
import { Legend } from '../components/Legend'
import { MapView } from '../components/MapView'
import { NavBar } from '../components/NavBar'

const ALL: InspectionPriority[] = ['high', 'medium', 'low', 'unknown']

export function AppLayout() {
  const graph = useGraph()
  const navigate = useNavigate()
  const plotMatch = useMatch('/plot/:plotId')
  const [active, setActive] = useState(() => new Set<InspectionPriority>(ALL))

  const counts = useMemo(() => {
    const c = { high: 0, medium: 0, low: 0, unknown: 0 } as Record<InspectionPriority, number>
    graph.data?.nodes.forEach((n) => { c[n.inspection_priority] += 1 })
    return c
  }, [graph.data])

  const visible = useMemo<GraphResponse | null>(() => {
    if (!graph.data) return null
    const nodes = graph.data.nodes.filter((n) => active.has(n.inspection_priority))
    const ids = new Set(nodes.map((n) => n.id))
    return { ...graph.data, nodes, edges: graph.data.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) }
  }, [graph.data, active])

  const toggle = (p: InspectionPriority) =>
    setActive((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })

  return (
    <div className="relative h-full w-full overflow-hidden">
      {visible && (
        <MapView
          graph={visible}
          selectedId={plotMatch?.params.plotId ?? null}
          onSelect={(id) => navigate(id ? `/plot/${id}` : '/')}
        />
      )}

      {/* Subtle vignette so the panels stand out over the map. */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_55%,rgb(11_14_19/0.55))]" />

      {!graph.data && (
        <div className="absolute inset-0 grid place-items-center bg-[radial-gradient(circle_at_center,var(--color-panel),var(--color-bg)_70%)] text-sm text-ink-muted">
          {graph.isPending ? (
            <div className="flex flex-col items-center gap-3">
              <Loader2 size={28} className="animate-spin text-accent" />
              Loading plots…
            </div>
          ) : (
            <div role="alert" className="glass flex flex-col items-center gap-2 px-8 py-6 text-center">
              <TriangleAlert size={24} className="text-prio-high" />
              <p className="font-medium text-prio-high">Could not load the plot graph.</p>
              <button onClick={() => void graph.refetch()} className="btn-ghost mt-2">
                <RefreshCw size={14} />Retry
              </button>
            </div>
          )}
        </div>
      )}

      {/* Notices under the menu: centered, the right panel covered them on narrow screens. */}
      <div className="absolute top-4 left-4 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col items-start gap-2">
        <NavBar />
        {graph.data?.nodes.some((n) => n.is_demo) && (
          <div role="status" className="flex animate-fade-in items-center gap-2 rounded-full border border-accent/30 bg-panel/85 px-4 py-1.5 text-xs font-medium text-accent shadow-float backdrop-blur-md">
            <FlaskConical size={14} />Demo mode: simulated data
          </div>
        )}
        <ConnectionBanner query={graph} />
      </div>

      <div className="absolute bottom-4 left-4 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2">
        <Filters active={active} counts={counts} onToggle={toggle} />
        <Legend />
      </div>

      <div className="absolute top-4 right-4 bottom-4 flex">
        <Outlet />
      </div>
    </div>
  )
}
