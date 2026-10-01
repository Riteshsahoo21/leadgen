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
  const [tab, setTab] = useState<'website_improvement' | 'new_website'>('website_improvement');
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  async function load() {
    try {
      const value = await api<{ run: Run; companies: Lead[]; total: number }>(`/api/runs/${id}?opportunity=${tab}&qualified=true&limit=100&offset=${page * 100}`);
      setRun(value.run); setCompanies(value.companies); setTotal(value.total); setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  usePolling(load, 2_500, `${id}:${tab}:${page}`);
  if (!run) return error ? <div className="alert">{error}</div> : <LoadingRows count={8} />;
  const state = run.discovery_state;
  return <>
    <Link className="back-link" to="/runs"><ArrowLeft size={15} /> Back to discovery runs</Link>
    <PageHeader eyebrow="DISCOVERY RUN" title={run.name} description={`${run.business_types.join(', ')} across ${run.cities.join(', ')}, ${run.country}`} actions={<><Badge value={run.status} /><RunControls run={run} onChange={load} /></>} />
    {error && <div className="alert">{error}</div>}
    {run.error && <div className="alert">{run.error}</div>}
    <p className="run-progress" aria-live="polite">
      {formatNumber(run.stats.qualified)} / {formatNumber(run.target_count)} qualified leads
      {' '}({formatNumber(run.stats.no_website ?? 0)} / {Math.ceil(run.target_count * 0.6)} without a website [Phase 1: 60%];
      {' '}{formatNumber(run.stats.incomplete_website ?? 0)} / {run.target_count - Math.ceil(run.target_count * 0.6)} needing website improvements [Phase 2: 40%]).
      {' '}{formatNumber(run.stats.discovered)} businesses discovered; {run.stats.pending ?? 0} actively processing.
      {Boolean(run.stats.deferred_website) && <> ({run.stats.deferred_website} websites on hold).</>}
      {run.status === 'running' && !run.discovery_finished_at && state?.keywords && (
        <span style={{ display: 'inline-block', marginLeft: '0.5rem', color: '#0ea5e9', fontWeight: 600 }}>
          ● Scraping Google Maps: Batch {state.cursor ?? 0} / {state.keywords.length} (Fast Mode)...
        </span>
      )}
      {Boolean((run.stats.active_crawling || run.stats.active_researching || run.stats.active_enriching)) && (
        <span style={{ display: 'inline-block', marginLeft: '0.5rem', color: '#10b981', fontWeight: 600 }}>
          [Active: {run.stats.active_crawling ?? 0} Crawling, {run.stats.active_researching ?? 0} Researching, {run.stats.active_enriching ?? 0} Enriching]
        </span>
      )}
      {state?.reason === 'search_plan_exhausted' && <> Search coverage exhausted below target. Add more cities or categories for additional unique results.</>}
      {run.status === 'paused' && <> Paused; queued work is retained. A current external request may finish.</>}
    </p>
    <section className="run-kpis">
      {Object.entries(run.stats)
        .filter(([, value]) => typeof value === 'number')
        .map(([key, value]) => (
          <div key={key}>
            <span>{key.replaceAll('_', ' ')}</span>
            <strong>{formatNumber(Number(value))}</strong>
          </div>
        ))}
    </section>
    <Panel 
      title="Qualified Opportunities" 
      subtitle={`${total ? page * 100 + 1 : 0}–${Math.min((page + 1) * 100, total)} of ${total} records`}
      action={
        <div className="segmented">
          <button className={tab === 'website_improvement' ? 'active' : ''} onClick={() => { setPage(0); setTab('website_improvement'); }}>
            Websites Needing Improvement ({run.stats.incomplete_website ?? 0})
          </button>
          <button className={tab === 'new_website' ? 'active' : ''} onClick={() => { setPage(0); setTab('new_website'); }}>
            Businesses with No Website ({run.stats.no_website ?? 0})
          </button>
        </div>
      }
    >
      <div className="table-wrap"><table><thead><tr><th>Business</th><th>City</th><th>Category</th><th>Score / rank</th><th>Status</th></tr></thead>
        <tbody>{companies.map((company) => <tr key={company.id}><td><Link className="table-title" to={`/businesses/${company.id}`}>{company.name}</Link></td><td>{company.city ?? '—'}</td><td>{company.category ?? '—'}</td><td><Score value={company.qualification_score ?? company.filter_score} />{company.run_rank ? <small> #{company.run_rank}/{company.run_total}</small> : null}</td><td><Badge value={company.status} /></td></tr>)}</tbody></table>
        {!companies.length && <EmptyState icon={Building2} title="No businesses in this view" detail="Businesses will appear here as they are evaluated and qualified." />}
      </div>
      <div className="pagination"><button className="button button-outline" disabled={!page} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page + 1} of {Math.max(1, Math.ceil(total / 100))}</span><button className="button button-outline" disabled={(page + 1) * 100 >= total} onClick={() => setPage(page + 1)}>Next</button></div>
    </Panel>
  </>;
}
