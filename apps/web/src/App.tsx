import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/AppLayout';
import { useDashboard } from './context/DashboardContext';
import { BusinessDetailPage } from './pages/BusinessDetailPage';
import { BusinessesPage } from './pages/BusinessesPage';
import { CampaignsPage } from './pages/CampaignsPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OverviewPage } from './pages/OverviewPage';
import { QualificationPage } from './pages/QualificationPage';
import { RepliesPage } from './pages/RepliesPage';
import { RunDetailPage } from './pages/RunDetailPage';
import { RunsPage } from './pages/RunsPage';
import { SettingsPage } from './pages/SettingsPage';

export default function App() {
  const { authenticated, loading } = useDashboard();
  return <Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route element={loading ? <AppLoading /> : authenticated ? <AppLayout /> : <Navigate to="/login" replace />}>
      <Route index element={<Navigate to="/overview" replace />} />
      <Route path="/overview" element={<OverviewPage />} />
      <Route path="/businesses" element={<BusinessesPage />} />
      <Route path="/businesses/:id" element={<BusinessDetailPage />} />
      <Route path="/qualification" element={<QualificationPage />} />
      <Route path="/runs" element={<RunsPage />} />
      <Route path="/runs/:id" element={<RunDetailPage />} />
      <Route path="/campaigns" element={<CampaignsPage />} />
      <Route path="/replies" element={<RepliesPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Route>
  </Routes>;
}

function AppLoading() {
  return <div className="app-loading"><span className="brand-mark">L</span><div><strong>LeadForge</strong><small>Connecting to your workspace…</small></div></div>;
}
