import { Ban, MapPinned, Plus, Workflow } from 'lucide-react';
import { useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { api, type Run } from '../api';
import { useDashboard } from '../context/DashboardContext';
import { Badge, EmptyState, formatNumber, PageHeader, Panel, relativeTime } from '../components/Ui';

export function RunsPage() {
  const { data, refresh } = useDashboard();
  const { openCreate } = useOutletContext<{ openCreate: () => void }>();
  const [busy, setBusy] = useState('');
  async function cancel(run: Run) { setBusy(run.id); try { await api(`/api/runs/${run.id}/cancel`, { method: 'POST' }); await refresh(); } finally { setBusy(''); } }
  return <>
    <PageHeader eyebrow="DISCOVERY CONTROL" title="Discovery runs" description="Every market request and its current pipeline yield." actions={<button className="button button-primary" onClick={openCreate}><Plus size={16} /> New discovery</button>} />
    <Panel><div className="run-list">{data.runs.map((run) => <article key={run.id}><div className="run-icon"><MapPinned size={19} /></div><div className="run-main"><div><Link to={`/runs/${run.id}`}>{run.name}</Link><Badge value={run.status} /></div><p>{run.business_types.join(', ')} · {run.cities.join(', ')}, {run.country}</p><small>{run.provider_mode} mode · started {relativeTime(run.created_at)}</small></div><div className="run-stat"><strong>{formatNumber(run.stats?.qualified ?? 0)}</strong><span>qualified</span></div><div className="run-stat"><strong>{formatNumber(run.stats?.verified ?? 0)}</strong><span>verified</span></div>{['queued', 'running'].includes(run.status) ? <button className="icon-button danger" disabled={busy === run.id} onClick={() => void cancel(run)} title="Cancel run"><Ban size={16} /></button> : <span />}</article>)}</div>{!data.runs.length && <EmptyState icon={Workflow} title="No discovery runs" detail="Create your first market request to start the pipeline." />}</Panel>
  </>;
}
