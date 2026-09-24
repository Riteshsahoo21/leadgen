import { ArrowLeft, Building2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Lead, type Run } from '../api';
import { Badge, EmptyState, formatNumber, LoadingRows, PageHeader, Panel, Score } from '../components/Ui';
import { RunControls } from '../components/RunControls';
import { usePolling } from '../hooks/usePolling';

export function RunDetailPage() {
  const { id } = useParams();
  const [run, setRun] = useState<Run>();
  const [companies, setCompanies] = useState<Lead[]>([]);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  async function load() {
    try {
      const value = await api<{ run: Run; companies: Lead[]; total: number }>(`/api/runs/${id}?limit=100&offset=${page * 100}`);
      setRun(value.run); setCompanies(value.companies); setTotal(value.total); setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  usePolling(load, 5_000, `${id}:${page}`);
  if (!run) return error ? <div className="alert">{error}</div> : <LoadingRows count={8} />;
  const state = run.discovery_state;
  return <>
    <Link className="back-link" to="/runs"><ArrowLeft size={15} /> Back to discovery runs</Link>
    <PageHeader eyebrow="DISCOVERY RUN" title={run.name} description={`${run.business_types.join(', ')} across ${run.cities.join(', ')}, ${run.country}`} actions={<><Badge value={run.status} /><RunControls run={run} onChange={load} /></>} />
    {error && <div className="alert">{error}</div>}
    {run.error && <div className="alert">{run.error}</div>}
    <p className="run-progress" aria-live="polite">
      {formatNumber(run.stats.discovered)} / {formatNumber(run.target_count)} unique businesses discovered.
      {' '}{run.stats.pending ?? 0} businesses processing; {run.stats.ai_pending ?? 0} AI explanations pending.
      {state?.keywords && <> Search batches: {state.cursor ?? 0} / {state.keywords.length}.</>}
      {state?.reason === 'search_plan_exhausted' && <> Search coverage exhausted below target. Add more cities or categories for additional unique results.</>}
      {run.status === 'paused' && <> Paused; queued work is retained. A current external request may finish.</>}
    </p>
    <section className="run-kpis">{Object.entries(run.stats).map(([key, value]) => <div key={key}><span>{key.replaceAll('_', ' ')}</span><strong>{formatNumber(value ?? 0)}</strong></div>)}</section>
    <Panel title="Companies in this run" subtitle={`${total ? page * 100 + 1 : 0}–${Math.min((page + 1) * 100, total)} of ${total} records, ranked by qualification score`}>
      <div className="table-wrap"><table><thead><tr><th>Business</th><th>City</th><th>Category</th><th>Score / rank</th><th>Status</th></tr></thead>
        <tbody>{companies.map((company) => <tr key={company.id}><td><Link className="table-title" to={`/businesses/${company.id}`}>{company.name}</Link></td><td>{company.city ?? '—'}</td><td>{company.category ?? '—'}</td><td><Score value={company.qualification_score ?? company.filter_score} />{company.run_rank ? <small> #{company.run_rank}/{company.run_total}</small> : null}</td><td><Badge value={company.status} /></td></tr>)}</tbody></table>
        {!companies.length && <EmptyState icon={Building2} title="No businesses on this page" detail="New results appear after each bounded discovery batch." />}
      </div>
      <div className="pagination"><button className="button button-outline" disabled={!page} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page + 1} of {Math.max(1, Math.ceil(total / 100))}</span><button className="button button-outline" disabled={(page + 1) * 100 >= total} onClick={() => setPage(page + 1)}>Next</button></div>
    </Panel>
  </>;
}
