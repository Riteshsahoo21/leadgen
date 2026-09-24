import { Building2, CheckCircle2, ExternalLink, Search, Globe } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, queryString, type Lead } from '../api';
import { Badge, EmptyState, LoadingRows, PageHeader, Panel, Score, StatCard } from '../components/Ui';
import { useDashboard } from '../context/DashboardContext';
import { usePolling } from '../hooks/usePolling';

type Response = { items: Lead[]; total: number; limit: number; offset: number };

export function BusinessesPage() {
  const { data: dashboard } = useDashboard();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<Response>({ items: [], total: 0, limit: 50, offset: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const search = params.get('search') ?? '';
  const status = params.get('status') ?? '';
  const page = Math.max(0, Number(params.get('page')) || 0);
  const setPage = (value: number) => setParams((current) => { current.set('page', String(value)); return current; });

  usePolling(async () => {
    try {
      const response = await api<Response>(`/api/businesses${queryString({ search, status, limit: 100, offset: page * 100 })}`);
      setData(response); setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  }, 5_000, `${search}:${status}:${page}`);

  return <>
    <PageHeader eyebrow="LEAD DATABASE" title="Businesses" description="Maps discovery counts unique businesses. Website crawling and qualification process them in parallel. A 5,000 target is 5,000 discovered businesses, not 5,000 qualified leads." />
    <section className="stats-grid stats-grid-three">
      <StatCard label="Businesses discovered" value={dashboard.overview.businesses} note="Unique Maps records saved" icon={Building2} />
      <StatCard label="Websites crawled" value={dashboard.overview.websites_crawled ?? 0} note="Businesses with successfully checked pages" icon={Globe} tone="cyan" />
      <StatCard label="Qualified opportunities" value={dashboard.overview.qualified} note={`${dashboard.overview.evaluated ?? 0} businesses evaluated`} icon={CheckCircle2} tone="green" />
    </section>
    <Panel className="filter-panel"><div className="filters"><label className="search-field"><Search size={17} /><input defaultValue={search} placeholder="Search name, city, category, or domain" onKeyDown={(event) => { if (event.key === 'Enter') setParams((current) => { current.set('page', '0'); current.set('search', event.currentTarget.value); return current; }); }} /></label><select value={status} onChange={(event) => setParams((current) => { current.set('page', '0'); event.target.value ? current.set('status', event.target.value) : current.delete('status'); return current; })}><option value="">All statuses</option><option value="email_verified">Email verified</option><option value="research_queued">Research queued</option><option value="qualified">Qualified</option><option value="unqualified">Unqualified</option><option value="no_email">No email</option><option value="filtered_out">Filtered out</option></select></div></Panel>
    {error && <div className="alert">{error}</div>}
    <Panel><div className="table-wrap business-table"><table><thead><tr><th>Business</th><th>Contact</th><th>Market</th><th>Signals</th><th>Outreach priority</th><th>Status</th></tr></thead><tbody>{data.items.map((lead) => <tr key={lead.id}><td><Link className="table-title" to={`/businesses/${lead.id}`}>{lead.name}</Link><small>{lead.domain ?? lead.category ?? 'No website detected'}</small></td><td><strong>{lead.full_name ?? 'Researching'}</strong><small>{lead.email ?? lead.phone ?? 'No contact yet'}</small></td><td>{lead.city ?? '—'}<small>{lead.country}</small></td><td><span className="signal-row">{lead.website && <a href={lead.website} target="_blank" rel="noreferrer" title="Open website"><ExternalLink size={14} /></a>}<span>{lead.review_count ?? 0} reviews</span></span></td><td><Score value={lead.qualification_score ?? lead.filter_score} /></td><td><Badge value={lead.status} /></td></tr>)}</tbody></table>{loading && <LoadingRows />}{!loading && !data.items.length && <EmptyState icon={Building2} title="No matching businesses" detail="Adjust the filters or create a new discovery run." />}</div><div className="pagination"><button className="button button-outline" disabled={!page} onClick={() => setPage(page - 1)}>Previous</button><span>{data.total.toLocaleString()} matching businesses · Page {page + 1} of {Math.max(1, Math.ceil(data.total / 100))}</span><button className="button button-outline" disabled={(page + 1) * 100 >= data.total} onClick={() => setPage(page + 1)}>Next</button></div></Panel>
  </>;
}
