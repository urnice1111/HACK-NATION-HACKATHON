import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { useNavigate } from 'react-router'

type Props = { title: string; subtitle?: string; children: ReactNode; wide?: boolean; icon?: ReactNode }

// Panel flotante a la derecha del mapa, compartido por todas las pantallas.
export function Panel({ title, subtitle, children, wide = false, icon }: Props) {
  const navigate = useNavigate()
  return (
    <aside
      aria-label={title}
      className={`glass flex max-h-full animate-panel-in flex-col overflow-hidden ${wide ? 'w-[30rem]' : 'w-[23rem]'} max-w-[calc(100vw-2rem)]`}
    >
      <div className="flex items-start justify-between gap-3 border-b border-line/80 bg-gradient-to-b from-panel-2/60 to-transparent px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          {icon && (
            <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg border border-accent/30 bg-accent/10 text-accent">
              {icon}
            </span>
          )}
          <div className="min-w-0">
            <h2 className="truncate text-lg leading-tight font-semibold">{title}</h2>
            {subtitle && <p className="mt-0.5 text-sm text-ink-muted">{subtitle}</p>}
          </div>
        </div>
        <button
          onClick={() => navigate('/')}
          aria-label="Cerrar"
          title="Cerrar"
          className="grid size-8 shrink-0 place-items-center rounded-md text-ink-muted transition-colors hover:bg-panel-2 hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
    </aside>
  )
}
