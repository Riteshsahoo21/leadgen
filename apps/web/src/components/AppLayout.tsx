import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  BarChart3, Building2, CheckCircle2, CircleHelp, LogOut, Mail, Menu, MessageSquareReply,
  Plus, Search, Settings, Sparkles, Workflow, X,
} from 'lucide-react';
import { clearToken } from '../api';
import { useDashboard } from '../context/DashboardContext';
import { CreateRunModal } from './CreateRunModal';

const navigation = [
  { to: '/overview', label: 'Overview', icon: BarChart3 },
  { to: '/businesses', label: 'Businesses', icon: Building2 },
  { to: '/qualification', label: 'Qualification', icon: Sparkles },
  { to: '/runs', label: 'Discovery runs', icon: Workflow },
  { to: '/campaigns', label: 'Campaigns', icon: Mail },
  { to: '/replies', label: 'Replies', icon: MessageSquareReply },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function AppLayout() {
  const [createOpen, setCreateOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { data } = useDashboard();
  const location = useLocation();
  const navigate = useNavigate();

  function logout() {
    clearToken();
    navigate('/login');
    window.location.reload();
  }

  return <div className="app-shell">
    <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
      <div className="sidebar-head"><NavLink className="brand" to="/overview"><span className="brand-mark">L</span><span>LeadForge<small>Intelligence workspace</small></span></NavLink><button className="icon-button mobile-only" onClick={() => setMobileOpen(false)}><X size={18} /></button></div>
      <nav>{navigation.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} onClick={() => setMobileOpen(false)} className={({ isActive }) => isActive ? 'active' : ''}><Icon size={18} /><span>{label}</span>{to === '/replies' && <small>{data.events.filter((event) => event.stage === 'reply').length}</small>}</NavLink>)}</nav>
      <div className="sidebar-card"><span><CheckCircle2 size={15} /> Resource guard active</span><strong>Production profile</strong><small>Parallel queues with bounded workers</small></div>
      <div className="sidebar-foot"><button className="sidebar-link"><CircleHelp size={17} /> Help & documentation</button><button className="sidebar-link" onClick={logout}><LogOut size={17} /> Sign out</button></div>
    </aside>
    <div className="workspace">
      <header className="workspace-bar">
        <button className="icon-button mobile-only" onClick={() => setMobileOpen(true)}><Menu size={19} /></button>
        <div className="global-search"><Search size={17} /><input aria-label="Search" placeholder="Search businesses, runs, or contacts" onKeyDown={(event) => { if (event.key === 'Enter' && event.currentTarget.value.trim()) navigate(`/businesses?search=${encodeURIComponent(event.currentTarget.value.trim())}`); }} /></div>
        <div className="workspace-actions"><div className="system-state"><span className={data.overview.active_runs ? 'live-dot' : 'ready-dot'} /><div><strong>{data.overview.active_runs ? 'Pipeline active' : 'System ready'}</strong><small>{data.overview.active_runs ? `${data.overview.active_runs} run processing` : 'All services connected'}</small></div></div><button className="button button-primary" onClick={() => setCreateOpen(true)}><Plus size={16} /> New discovery</button></div>
      </header>
      <main className="page" key={location.pathname}><Outlet context={{ openCreate: () => setCreateOpen(true) }} /></main>
    </div>
    {createOpen && <CreateRunModal onClose={() => setCreateOpen(false)} />}
  </div>;
}
