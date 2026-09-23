import { ArrowRight, BarChart3, Database, ShieldCheck, Workflow } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { getToken, setToken as persistToken } from '../api';
import { useDashboard } from '../context/DashboardContext';

export function LoginPage() {
  const { authenticated, loading, error, refresh } = useDashboard();
  const [token, setToken] = useState(getToken());
  if (authenticated) return <Navigate to="/overview" replace />;
  async function connect(event: FormEvent) { event.preventDefault(); persistToken(token.trim()); await refresh(); }
  return <div className="login-page"><section className="login-showcase"><div className="brand brand-login"><span className="brand-mark">L</span><span>LeadForge<small>Intelligence workspace</small></span></div><div className="login-copy"><p className="eyebrow">SELF-HOSTED LEAD OPERATIONS</p><h1>Build a qualified business pipeline with every stage under your control.</h1><p>Discover, research, score, and enrich public business opportunities from one private workspace.</p><div className="login-features"><span><Workflow size={18} /> Parallel processing</span><span><Database size={18} /> PostgreSQL source of truth</span><span><BarChart3 size={18} /> Live operational visibility</span></div></div><div className="login-grid-art" /></section><section className="login-form-wrap"><form className="login-card" onSubmit={(event) => void connect(event)}><i><ShieldCheck size={24} /></i><p className="eyebrow">SECURE ACCESS</p><h2>Open your workspace</h2><p>Enter the private API token configured on the VPS.</p><label>API token<input autoFocus type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Paste your API token" required /></label>{error && <div className="alert">{error}</div>}<button className="button button-primary" disabled={loading}>{loading ? 'Connecting…' : <>Continue <ArrowRight size={16} /></>}</button><small>The token is stored only in this browser.</small></form></section></div>;
}
