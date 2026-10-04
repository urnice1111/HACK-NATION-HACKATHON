import { MessageSquare, Phone, PhoneCall } from 'lucide-react'
import { Link } from 'react-router'
import { useFollowups } from '../api/hooks'
import type { FollowUp } from '../api/types'
import { Badge } from '../components/Badge'
import { Panel } from '../components/Panel'
import { QueryBoundary } from '../components/QueryBoundary'
import { formatRelative } from '../lib/format'
import { STATUS_REPORTED } from '../lib/labels'

type Group = { key: string; title: string; dot: string; match: (f: FollowUp, now: number) => boolean }

const GROUPS: Group[] = [
  { key: 'overdue', title: 'Vencidos', dot: 'bg-prio-high', match: (f, now) => f.status === 'scheduled' && new Date(f.due_at).getTime() < now },
  { key: 'contacting', title: 'En curso', dot: 'bg-prio-low', match: (f) => f.status === 'contacting' },
  { key: 'scheduled', title: 'Programados', dot: 'bg-ink-muted', match: (f, now) => f.status === 'scheduled' && new Date(f.due_at).getTime() >= now },
  { key: 'no_response', title: 'Sin respuesta', dot: 'bg-prio-medium', match: (f) => f.status === 'no_response' || f.status === 'failed' },
  { key: 'responded', title: 'Respondidos', dot: 'bg-accent', match: (f) => f.status === 'responded' },
]

function Item({ f, group }: { f: FollowUp; group: string }) {
  return (
    <li className="card space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to={`/parcela/${f.plot_id}`} className="plot-link">{f.plot_label}</Link>
        <span className={`text-xs ${group === 'overdue' ? 'font-medium text-prio-high' : 'text-ink-muted'}`}>
          {group === 'overdue' ? 'Venció ' : ''}{formatRelative(f.due_at)}
        </span>
      </div>
      <p className="text-sm text-ink-muted">{f.case_summary}</p>
      <div className="flex flex-wrap gap-1.5">
        <Badge>{f.channel === 'voice' ? <><Phone size={11} />Llamada</> : <><MessageSquare size={11} />SMS</>}</Badge>
        <Badge>Intento {f.attempt_count} de {f.max_attempts}</Badge>
        {f.status_reported && (
          <Badge tone={f.status_reported === 'resolved' || f.status_reported === 'improved' ? 'accent' : 'medium'}>
            {STATUS_REPORTED[f.status_reported]}
          </Badge>
        )}
      </div>
      {f.actions_taken && <p className="rounded-md bg-bg/50 px-2.5 py-1.5 text-sm"><span className="text-ink-muted">Qué hizo: </span>{f.actions_taken}</p>}
      {group === 'no_response' && (
        <p className="text-xs text-prio-medium">Sin respuesta no baja el riesgo: la prioridad se mantiene.</p>
      )}
    </li>
  )
}

export function FollowupsPage() {
  const followups = useFollowups()
  return (
    <Panel title="Seguimientos" subtitle="Llamadas para saber cómo sigue cada caso" icon={<PhoneCall size={18} />} wide>
      <QueryBoundary query={followups} isEmpty={(d) => d.items.length === 0} empty="No hay seguimientos programados.">
        {(d) => {
          const now = Date.now()
          return (
            <div className="space-y-5">
              {GROUPS.map((g) => {
                const items = d.items.filter((f) => g.match(f, now))
                if (!items.length) return null
                return (
                  <section key={g.key}>
                    <h3 className="section-title mb-2 flex items-center gap-2">
                      <span className={`size-2 rounded-full ${g.dot}`} />{g.title}<span className="font-normal">· {items.length}</span>
                    </h3>
                    <ul className="space-y-2">{items.map((f) => <Item key={f.id} f={f} group={g.key} />)}</ul>
                  </section>
                )
              })}
            </div>
          )
        }}
      </QueryBoundary>
    </Panel>
  )
}
