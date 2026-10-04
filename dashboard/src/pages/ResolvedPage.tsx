import { CalendarCheck, CheckCircle2 } from 'lucide-react'
import { Link } from 'react-router'
import { useResolvedCases } from '../api/hooks'
import type { ResolvedCase } from '../api/types'
import { Badge } from '../components/Badge'
import { Panel } from '../components/Panel'
import { QueryBoundary } from '../components/QueryBoundary'
import { formatDate } from '../lib/format'
import { VERIFICATION } from '../lib/labels'

function protocolBadge(r: ResolvedCase) {
  if (r.matches_protocol === true) return <Badge tone="accent">Coincide con el protocolo</Badge>
  if (r.matches_protocol === false) return <Badge tone="medium">Fuera de protocolo: el asesor no lo recomienda</Badge>
  return <Badge>Sin clasificar</Badge>
}

export function ResolvedPage() {
  const resolved = useResolvedCases()
  return (
    <Panel title="Casos resueltos" subtitle="Lo que funcionó en otras parcelas, según quién lo confirmó" icon={<CheckCircle2 size={18} />} wide>
      <QueryBoundary query={resolved} isEmpty={(d) => d.items.length === 0} empty="Aún no hay casos resueltos. Aparecen al cerrar un seguimiento.">
        {(d) => (
          <ul className="space-y-2">
            {d.items.map((r) => (
              <li key={r.id} className="card space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link to={`/parcela/${r.plot_id}`} className="plot-link">{r.plot_label}</Link>
                  <span className="flex items-center gap-1 text-xs text-ink-muted"><CalendarCheck size={12} />{formatDate(r.resolved_at)}</span>
                </div>
                <p className="text-sm leading-relaxed">{r.solution_statement}</p>
                <div className="flex flex-wrap items-center gap-1 text-xs text-ink-muted">
                  Síntomas:
                  {r.symptoms.map((s) => <span key={s} className="rounded bg-bg/60 px-1.5 py-0.5 text-ink">{s}</span>)}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge tone={VERIFICATION[r.verification].tone}>{VERIFICATION[r.verification].label}</Badge>
                  {protocolBadge(r)}
                  {r.outcome === 'improved_enough' && <Badge>Mejoró lo suficiente</Badge>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
    </Panel>
  )
}
