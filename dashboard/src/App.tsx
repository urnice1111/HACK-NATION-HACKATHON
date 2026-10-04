import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { ApiError } from './api/client'
import { AppLayout } from './layout/AppLayout'
import { AlertDetailPage } from './pages/AlertDetailPage'
import { AlertsPage } from './pages/AlertsPage'
import { FollowupsPage } from './pages/FollowupsPage'
import { PlotPage } from './pages/PlotPage'
import { ResolvedPage } from './pages/ResolvedPage'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 4xx (e.g. an alert id that doesn't exist) won't fix itself; retry only network and 5xx errors.
      retry: (failures, error) => failures < 1 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
      refetchOnWindowFocus: true,
    },
  },
})

// No login: the panel opens directly. Whoever operates it approves or rejects alerts.
function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={null} />
        <Route path="plot/:plotId" element={<PlotPage />} />
        <Route path="alerts" element={<AlertsPage />} />
        <Route path="alerts/:alertId" element={<AlertDetailPage />} />
        <Route path="followups" element={<FollowupsPage />} />
        <Route path="resolved" element={<ResolvedPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  )
}
