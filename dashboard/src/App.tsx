import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { AuthProvider, useAuth } from './auth/AuthContext'
import { AppLayout } from './layout/AppLayout'
import { AlertsPage } from './pages/AlertsPage'
import { FollowupsPage } from './pages/FollowupsPage'
import { LoginPage } from './pages/LoginPage'
import { PlotPage } from './pages/PlotPage'
import { ResolvedPage } from './pages/ResolvedPage'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } },
})

function AppRoutes() {
  const { user } = useAuth()
  if (!user) return <LoginPage />
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={null} />
        <Route path="parcela/:plotId" element={<PlotPage />} />
        <Route path="alertas" element={<AlertsPage />} />
        <Route path="seguimientos" element={<FollowupsPage />} />
        <Route path="casos-resueltos" element={<ResolvedPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  )
}
