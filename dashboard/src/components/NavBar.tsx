import { useState } from 'react'
import { BellRing, CheckCircle2, Map, PhoneCall, RotateCcw, Sprout, WifiOff } from 'lucide-react'
import { NavLink } from 'react-router'
import { useAlerts, useFollowups, useResetDemo } from '../api/hooks'
import { API_MODE } from '../api'
import { mockControls } from '../api/mockAdapter'

function Count({ n, tone }: { n: number; tone: 'medium' | 'high' }) {
  if (!n) return null
  const cls = tone === 'high' ? 'bg-prio-high text-bg' : 'bg-prio-medium text-bg'
  return <span className={`absolute -top-1 -right-1 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[0.625rem] font-bold ring-2 ring-panel ${cls}`}>{n}</span>
}

export function NavBar() {
  const alerts = useAlerts()
  const followups = useFollowups()
  const reset = useResetDemo()
  const [offline, setOffline] = useState(mockControls.isOffline())

  const pending = alerts.data?.items.filter((a) => a.status === 'pending_review').length ?? 0
  const overdue =
    followups.data?.items.filter((f) => f.status === 'scheduled' && new Date(f.due_at).getTime() < Date.now()).length ?? 0

  const link = ({ isActive }: { isActive: boolean }) =>
    `relative flex flex-col items-center gap-1 rounded-lg px-1 py-2 text-[0.6875rem] font-medium transition-colors ${
      isActive ? 'bg-accent/10 text-accent' : 'text-ink-muted hover:bg-panel-2 hover:text-ink'
    }`

  const onReset = () => {
    if (window.confirm('¿Reiniciar la demo? Se restauran todos los datos simulados.')) reset.mutate()
  }

  return (
    <header className="glass w-[22rem] max-w-[calc(100vw-2rem)] animate-fade-in">
      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-accent to-emerald-600 text-accent-ink shadow-[0_4px_14px_-4px_rgb(52_211_153/0.6)]">
          <Sprout size={22} strokeWidth={2.25} />
        </span>
        <div className="min-w-0">
          <h1 className="text-base leading-tight font-semibold">Red de parcelas de café</h1>
          <p className="text-xs text-ink-muted">Roya del café · centro de Veracruz</p>
        </div>
      </div>

      <nav aria-label="Secciones" className="mx-3 mb-3 grid grid-cols-4 gap-1 rounded-xl border border-line/80 bg-bg/40 p-1">
        <NavLink to="/" end className={link}><Map size={17} />Mapa</NavLink>
        <NavLink to="/alertas" className={link}>
          <span className="relative"><BellRing size={17} /><Count n={pending} tone="medium" /></span>Alertas
        </NavLink>
        <NavLink to="/seguimientos" className={link}>
          <span className="relative"><PhoneCall size={17} /><Count n={overdue} tone="high" /></span>Seguimiento
        </NavLink>
        <NavLink to="/casos-resueltos" className={link}><CheckCircle2 size={17} />Resueltos</NavLink>
      </nav>

      {API_MODE === 'mock' && (
        <button
          onClick={onReset}
          disabled={reset.isPending}
          className="flex w-full items-center gap-2 border-t border-line/80 px-4 py-2.5 text-xs text-prio-medium transition-colors hover:bg-prio-medium/10 disabled:opacity-50"
        >
          <RotateCcw size={14} className={reset.isPending ? 'animate-spin' : ''} />Reiniciar demo
        </button>
      )}

      {API_MODE === 'mock' && (
        <label className="flex cursor-pointer items-center justify-between gap-2 border-t border-line/80 px-4 py-2.5 text-xs text-ink-muted">
          <span className="flex items-center gap-2"><WifiOff size={14} />Simular desconexión</span>
          <input
            type="checkbox"
            role="switch"
            checked={offline}
            onChange={(e) => { mockControls.setOffline(e.target.checked); setOffline(e.target.checked) }}
            className="peer sr-only"
          />
          <span className="relative h-5 w-9 rounded-full bg-line transition-colors peer-checked:bg-prio-medium peer-focus-visible:ring-2 peer-focus-visible:ring-accent after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-ink after:transition-transform peer-checked:after:translate-x-4" />
        </label>
      )}
    </header>
  )
}
