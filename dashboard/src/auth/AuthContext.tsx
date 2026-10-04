import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createClient } from '@supabase/supabase-js'
import { API_MODE } from '../api'
import { setTokenProvider } from '../api/httpAdapter'

export type Role = 'operator' | 'agronomist' | 'admin'
export type User = { name: string; role: Role }
type Action = 'review_alert' | 'reset_demo'

type AuthValue = {
  user: User | null
  usesSupabase: boolean
  signInDemo: (name: string, role: Role) => void
  signInWithPassword: (email: string, password: string) => Promise<string | null>
  signOut: () => void
  can: (action: Action) => boolean
}

const PERMISSIONS: Record<Action, Role[]> = {
  review_alert: ['operator', 'admin'],
  reset_demo: ['admin'],
}

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
// En modo http con Supabase configurado se usa Supabase Auth; si no, login de demo.
const supabase = API_MODE === 'http' && url && anonKey ? createClient(url, anonKey) : null

const DEMO_KEY = 'dashboard.demoUser'
const toRole = (r: unknown): Role => (r === 'admin' || r === 'agronomist' ? r : 'operator')

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    if (supabase) return null
    const saved = sessionStorage.getItem(DEMO_KEY)
    return saved ? (JSON.parse(saved) as User) : null
  })

  useEffect(() => {
    if (!supabase) return
    setTokenProvider(async () => (await supabase.auth.getSession()).data.session?.access_token ?? null)
    const fromSession = (s: { user: { email?: string; app_metadata: Record<string, unknown> } } | null) =>
      setUser(s ? { name: s.user.email ?? 'Operador', role: toRole(s.user.app_metadata.role) } : null)
    void supabase.auth.getSession().then(({ data }) => fromSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_event, session) => fromSession(session))
    return () => data.subscription.unsubscribe()
  }, [])

  const value = useMemo<AuthValue>(() => ({
    user,
    usesSupabase: Boolean(supabase),
    signInDemo: (name, role) => {
      const u = { name, role }
      sessionStorage.setItem(DEMO_KEY, JSON.stringify(u))
      setUser(u)
    },
    signInWithPassword: async (email, password) => {
      if (!supabase) return 'Supabase no está configurado.'
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      return error ? 'Correo o contraseña incorrectos.' : null
    },
    signOut: () => {
      sessionStorage.removeItem(DEMO_KEY)
      if (supabase) void supabase.auth.signOut()
      setUser(null)
    },
    can: (action) => Boolean(user && PERMISSIONS[action].includes(user.role)),
  }), [user])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth debe usarse dentro de AuthProvider')
  return ctx
}
