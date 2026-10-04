import { useState, type FormEvent } from 'react'
import { ArrowRight, FlaskConical, Loader2, Sprout } from 'lucide-react'
import { useAuth, type Role } from '../auth/AuthContext'

export function LoginPage() {
  const { usesSupabase, signInDemo, signInWithPassword } = useAuth()
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('operator')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (usesSupabase) {
      if (!email || !password) return setError('Escribe tu correo y contraseña.')
      setBusy(true)
      setError(await signInWithPassword(email, password))
      setBusy(false)
      return
    }
    if (!name.trim()) return setError('Escribe tu nombre para continuar.')
    signInDemo(name.trim(), role)
  }

  const label = 'block space-y-1.5 text-sm'
  const caption = 'text-xs font-medium text-ink-muted'

  return (
    <main className="relative grid h-full place-items-center overflow-hidden p-4">
      {/* Fondo: resplandor verde y retícula tenue, evocando el mapa de parcelas. */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_50%_0%,rgb(52_211_153/0.18),transparent_70%)]" />
      <div className="pointer-events-none absolute inset-0 [background-image:linear-gradient(var(--color-line)_1px,transparent_1px),linear-gradient(90deg,var(--color-line)_1px,transparent_1px)] [background-size:48px_48px] opacity-25 [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_70%)]" />

      <div className="relative w-full max-w-sm animate-fade-in">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-4 grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-accent to-emerald-600 text-accent-ink shadow-[0_8px_30px_-6px_rgb(52_211_153/0.6)]">
            <Sprout size={30} strokeWidth={2.25} />
          </span>
          <h1 className="text-2xl font-bold tracking-tight">Red de parcelas de café</h1>
          <p className="mt-1 text-sm text-ink-muted">Vigilancia de la roya en el centro de Veracruz</p>
        </div>

        <form onSubmit={submit} className="glass space-y-4 p-6" noValidate>
          {usesSupabase ? (
            <>
              <label className={label}>
                <span className={caption}>Correo</span>
                <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className="field" placeholder="tu@correo.com" />
              </label>
              <label className={label}>
                <span className={caption}>Contraseña</span>
                <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="field" />
              </label>
            </>
          ) : (
            <>
              <label className={label}>
                <span className={caption}>Tu nombre</span>
                <input value={name} onChange={(e) => { setName(e.target.value); setError(null) }} className="field" placeholder="Ana López" autoFocus />
              </label>
              <fieldset className="space-y-1.5">
                <legend className={`${caption} mb-1.5`}>Rol</legend>
                <div className="grid grid-cols-3 gap-1 rounded-lg border border-line bg-bg/60 p-1">
                  {([['operator', 'Operador'], ['agronomist', 'Agrónomo'], ['admin', 'Admin']] as const).map(([value, text]) => (
                    <label
                      key={value}
                      className={`cursor-pointer rounded-md py-1.5 text-center text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent ${
                        role === value ? 'bg-panel-2 font-medium text-ink shadow-sm ring-1 ring-line' : 'text-ink-muted hover:text-ink'
                      }`}
                    >
                      <input type="radio" name="role" value={value} checked={role === value} onChange={() => setRole(value)} className="sr-only" />
                      {text}
                    </label>
                  ))}
                </div>
              </fieldset>
            </>
          )}

          {error && (
            <p role="alert" className="rounded-md border border-prio-high/30 bg-prio-high/10 px-3 py-2 text-sm text-prio-high">{error}</p>
          )}

          <button type="submit" disabled={busy} className="btn-primary w-full py-2.5">
            {busy ? <><Loader2 size={16} className="animate-spin" />Entrando…</> : <>Entrar<ArrowRight size={16} /></>}
          </button>
        </form>

        {!usesSupabase && (
          <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-ink-muted">
            <FlaskConical size={13} className="text-accent" />
            Modo demo: no se pide contraseña y los datos son simulados.
          </p>
        )}
      </div>
    </main>
  )
}
