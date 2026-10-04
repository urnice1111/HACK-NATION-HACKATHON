import type { InspectionPriority } from '../api/types'
import { PRIORITY } from '../lib/priority'

const ORDER: InspectionPriority[] = ['high', 'medium', 'low', 'unknown']

type Props = {
  active: Set<InspectionPriority>
  counts: Record<InspectionPriority, number>
  onToggle: (p: InspectionPriority) => void
}

export function Filters({ active, counts, onToggle }: Props) {
  const total = ORDER.reduce((s, p) => s + counts[p], 0)
  return (
    <section aria-label="Filtrar por prioridad" className="glass animate-fade-in px-4 py-3">
      <div className="mb-2.5 flex items-baseline justify-between">
        <h2 className="section-title">Mostrar prioridad</h2>
        <span className="text-xs text-ink-muted">{total} parcelas</span>
      </div>

      {/* Barra de distribución: proporción de parcelas por prioridad. */}
      {total > 0 && (
        <div className="mb-3 flex h-1.5 overflow-hidden rounded-full bg-line" aria-hidden>
          {ORDER.map((p) => (
            <span
              key={p}
              className="h-full transition-all"
              style={{ width: `${(counts[p] / total) * 100}%`, background: PRIORITY[p].color, opacity: active.has(p) ? 1 : 0.25 }}
            />
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-1.5">
        {ORDER.map((p) => {
          const on = active.has(p)
          return (
            <button
              key={p}
              aria-pressed={on}
              onClick={() => onToggle(p)}
              className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm transition-all ${
                on ? 'border-line bg-panel-2 text-ink' : 'border-transparent text-ink-muted/70 hover:text-ink-muted'
              }`}
            >
              <span
                className="size-2.5 rounded-full transition-all"
                style={{ background: PRIORITY[p].color, opacity: on ? 1 : 0.35, boxShadow: on ? `0 0 8px ${PRIORITY[p].color}` : 'none' }}
              />
              <span className={on ? '' : 'line-through'}>{PRIORITY[p].label}</span>
              <span className="ml-auto text-xs font-semibold text-ink-muted">{counts[p]}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
