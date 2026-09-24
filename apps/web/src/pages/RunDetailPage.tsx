import { ArrowLeft, Ban, Building2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Lead, type Run } from '../api';
import { Badge, EmptyState, formatNumber, LoadingRows, PageHeader, Panel, Score } from '../components/Ui';
import { usePolling } from '../hooks/usePolling';

export function RunDetailPage() {
  const { id } = useParams();
  const [run, setRun] = useState<Run>();
  const [companies, setCompanies] = useState<Lead[]>([]);
  const [error, setError] = useState('');
  const [stopping, setStopping] = useState(false);
  usePolling(async () => {
    try {
      const value = await api<{ run: Run; companies: Lead[] }>(`/api/runs/${id}`);
      setRun(value.run); setCompanies(value.companies); setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, 5_000, id);
  async function stop() {
    if (!run || !window.confirm(`Stop ${run.name}? Pending jobs will be removed and active work will stop after its current request.`)) return;
    setStopping(true);
    try {
      await api(`/api/runs/${run.id}/cancel`, { method: 'POST' });
      setRun({ ...run, status: 'cancelled' });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setStopping(false); }
  }
  if (error) return <div className="alert">{error}</div>;
  if (!run) return <LoadingRows count={8} />;
  const actions = <><Badge value={run.status} />{['queued', 'running'].includes(run.status) && <button className="button button-outline" disabled={stopping} onClick={() => void stop()}><Ban size={15} /> Stop pipeline</button>}</>;
  return <>
    <Link className="back-link" to="/runs"><ArrowLeft size={15} /> Back to discovery runs</Link>
    <PageHeader eyebrow="DISCOVERY RUN" title={run.name} description={`${run.business_types.join(', ')} across ${run.cities.join(', ')}, ${run.country}`} actions={actions} />
    <section className="run-kpis">{Object.entries(run.stats).map(([key, value]) => <div key={key}><span>{key}</span><strong>{formatNumber(value)}</strong></div>)}</section>
    <Panel title="Companies in this run" subtitle={`Showing the top ${companies.length} records by qualification score`}>
      <div className="table-wrap"><table><thead><tr><th>Business</th><th>City</th><th>Category</th><th>Score / rank</th><th>Status</th></tr></thead><tbody>{companies.map((company) => <tr key={company.id}><td><Link className="table-title" to={`/businesses/${company.id}`}>{company.name}</Link></td><td>{company.city ?? '—'}</td><td>{company.category ?? '—'}</td><td><Score value={company.qualification_score ?? company.filter_score} />{company.run_rank ? <small> #{company.run_rank}/{company.run_total}</small> : null}</td><td><Badge value={company.status} /></td></tr>)}</tbody></table>{!companies.length && <EmptyState icon={Building2} title="No businesses yet" detail="Discovery is still waiting or has not returned candidates." />}</div>
    </Panel>
  </>;
}
