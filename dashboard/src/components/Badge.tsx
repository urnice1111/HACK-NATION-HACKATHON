import type { ReactNode } from 'react'

export type Tone = 'neutral' | 'accent' | 'high' | 'medium' | 'low' | 'unknown'

// Clases completas y estáticas para que Tailwind las detecte.
const TONES: Record<Tone, string> = {
  neutral: 'border-line bg-panel-2 text-ink-muted',
  accent: 'border-accent/30 bg-accent/10 text-accent',
  high: 'border-prio-high/30 bg-prio-high/10 text-prio-high',
  medium: 'border-prio-medium/30 bg-prio-medium/10 text-prio-medium',
  low: 'border-prio-low/30 bg-prio-low/10 text-prio-low',
  unknown: 'border-prio-unknown/40 bg-prio-unknown/15 text-ink-muted',
}

const DOTS: Record<Tone, string> = {
  neutral: 'bg-ink-muted/60',
  accent: 'bg-accent',
  high: 'bg-prio-high',
  medium: 'bg-prio-medium',
  low: 'bg-prio-low',
  unknown: 'bg-prio-unknown',
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${TONES[tone]}`}>
      {tone !== 'neutral' && <span className={`size-1.5 rounded-full ${DOTS[tone]}`} />}
      {children}
    </span>
  )
}
