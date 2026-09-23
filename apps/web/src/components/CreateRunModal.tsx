import { useMemo, useState, type FormEvent } from 'react';
import { MapPinned, X } from 'lucide-react';
import { api } from '../api';
import { useDashboard } from '../context/DashboardContext';

export function CreateRunModal({ onClose }: { onClose: () => void }) {
  const { refresh } = useDashboard();
  const [form, setForm] = useState({
    name: 'India growth list',
    country: 'India',
    cities: 'Mumbai, Bangalore, Bhubaneswar',
    businessTypes: 'dentist, agency, clinic, manufacturer',
    targetCount: 5000,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const queries = useMemo(() => split(form.cities).length * split(form.businessTypes).length, [form.cities, form.businessTypes]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/runs', { method: 'POST', body: JSON.stringify(form) });
      await refresh();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <form className="modal" onSubmit={submit}>
      <div className="modal-head"><div><p className="eyebrow">NEW DISCOVERY</p><h2>Define a market</h2><p>Each city and business type combination becomes an independently processed search.</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
      <div className="form-grid">
        <label className="span-2">Run name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></label>
        <label>Country<input value={form.country} onChange={(event) => setForm({ ...form, country: event.target.value })} placeholder="India" required /></label>
        <label>Target businesses<input type="number" min="1" max="50000" value={form.targetCount} onChange={(event) => setForm({ ...form, targetCount: Number(event.target.value) })} required /></label>
        <label className="span-2">Cities<textarea value={form.cities} onChange={(event) => setForm({ ...form, cities: event.target.value })} placeholder="Mumbai, Pune, Bangalore" required /><small>Enter one or more cities separated by commas.</small></label>
        <label className="span-2">Business types<textarea value={form.businessTypes} onChange={(event) => setForm({ ...form, businessTypes: event.target.value })} placeholder="dentist, clinic, restaurant, agency" required /><small>Use any niches. Duplicate values are removed.</small></label>
      </div>
      <div className="query-preview"><MapPinned size={20} /><div><strong>{queries} discovery queries</strong><small>Workers overlap stages while AI and browser concurrency remain guarded.</small></div></div>
      {error && <div className="alert">{error}</div>}
      <div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? 'Creating…' : 'Start discovery'}</button></div>
    </form>
  </div>;
}

function split(value: string) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}
