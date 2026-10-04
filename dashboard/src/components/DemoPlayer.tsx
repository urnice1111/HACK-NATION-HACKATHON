import { useEffect, useRef, useState } from 'react'
import { Pause, Play, RotateCcw } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { mockControls } from '../api/mockAdapter'

function formatElapsed(ms: number): string {
  const total = Math.min(60, Math.floor(ms / 1000))
  return `0:${String(total).padStart(2, '0')}`
}

export function DemoPlayer() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [snap, setSnap] = useState(() => mockControls.getSnapshot())
  const routeRef = useRef<string | null>(null)

  useEffect(() => {
    return mockControls.subscribe(() => {
      const next = mockControls.getSnapshot()
      setSnap(next)
      void qc.invalidateQueries()
      if (next.active && next.route && next.route !== routeRef.current) {
        routeRef.current = next.route
        navigate(next.route)
      }
      if (!next.active) routeRef.current = null
    })
  }, [qc, navigate])

  const onToggle = () => {
    if (snap.playing) mockControls.pauseDemo()
    else mockControls.startDemo()
  }

  const progress = Math.min(1, snap.elapsedMs / snap.durationMs)

  return (
    <div className="glass w-[22rem] max-w-[calc(100vw-2rem)] animate-fade-in p-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggle}
          className="btn-primary shrink-0 px-2.5 py-1.5 text-xs"
          aria-label={snap.playing ? 'Pausar simulación' : snap.finished ? 'Repetir simulación' : 'Reproducir simulación'}
        >
          {snap.playing ? <Pause size={14} /> : <Play size={14} />}
          {snap.playing ? 'Pausa' : snap.finished ? 'Repetir' : 'Play'}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2 text-[0.6875rem] text-ink-muted">
            <span className="font-semibold tracking-wide text-accent uppercase">
              {snap.active ? snap.clockLabel : 'Demo 1 min'}
            </span>
            <span>{formatElapsed(snap.elapsedMs)} / 1:00</span>
          </div>
          <div
            className="mt-1 h-1.5 overflow-hidden rounded-full bg-line"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={60}
            aria-valuenow={Math.floor(snap.elapsedMs / 1000)}
            aria-label="Progreso de la simulación"
          >
            <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
        {snap.active && (
          <button
            type="button"
            onClick={() => mockControls.resetDemo()}
            className="btn-ghost shrink-0 px-2 py-1.5 text-xs"
            aria-label="Salir de la simulación y restaurar datos"
            title="Salir y restaurar datos"
          >
            <RotateCcw size={13} />
          </button>
        )}
      </div>
      <p className="mt-2 text-xs leading-snug text-ink">{snap.caption}</p>
    </div>
  )
}
