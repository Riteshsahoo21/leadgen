import { MapPinned, Plus, Workflow } from 'lucide-react';
import { useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { api, type Run } from '../api';
import { useDashboard } from '../context/DashboardContext';
import { Badge, EmptyState, formatNumber, PageHeader, Panel, relativeTime } from '../components/Ui';
import { RunControls } from '../components/RunControls';
import { usePolling } from '../hooks/usePolling';

export function RunsPage() {
  const { refresh } = useDashboard();
  const { openCreate } = useOutletContext<{ openCreate: () => void }>();
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState('');
  async function load() {
    try { setRuns((await api<{ runs: Run[] }>('/api/runs')).runs); setError(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  usePolling(load);
  return <>
    <PageHeader eyebrow="DISCOVERY CONTROL" title="Discovery runs" description="Pause keeps your checkpoint. Resume continues saved work. Stop is permanent and preserves collected leads." actions={<button className="button button-primary" onClick={openCreate}><Plus size={16} /> New discovery</button>} />
    {error && <div className="alert">{error}</div>}
    <Panel><div className="run-list">{runs.map((run) => <article key={run.id}>
      <div className="run-icon"><MapPinned size={19} /></div>
      <div className="run-main"><div><Link to={`/runs/${run.id}`}>{run.name}</Link><Badge value={run.status} /></div>
        <p>{run.business_types.join(', ')} · {run.cities.join(', ')}, {run.country}</p>
        <small>{formatNumber(run.stats?.discovered ?? 0)} / {formatNumber(run.target_count)} discovered · {run.stats?.pending ?? 0} processing · {run.stats?.ai_pending ?? 0} AI pending</small>
        <small>{run.provider_mode} mode · created {relativeTime(run.created_at)}</small>
      </div>
      <div className="run-stat"><strong>{formatNumber(run.stats?.evaluated ?? 0)}</strong><span>evaluated</span></div>
      <div className="run-stat"><strong>{formatNumber(run.stats?.qualified ?? 0)}</strong><span>qualified</span></div>
      <RunControls run={run} onChange={async () => { await load(); await refresh(); }} />
    </article>)}</div>{!runs.length && <EmptyState icon={Workflow} title="No discovery runs" detail="Create your first market request to start the pipeline." />}</Panel>
  </>;
}
