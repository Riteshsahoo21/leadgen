import { BrainCircuit, CheckCircle2, Gauge } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, queryString, type Qualification, type QualificationSummary } from '../api';
import { Badge, EmptyState, LoadingRows, PageHeader, Panel, Score, StatCard } from '../components/Ui';
import { usePolling } from '../hooks/usePolling';

const filters = [
  ['all', 'All evaluated'],
  ['actionable', 'Qualified'],
  ['new_website', 'No website'],
  ['website_improvement', 'Incomplete website'],
  ['manual_review', 'Manual review'],
] as const;

const emptySummary: QualificationSummary = {
  evaluated: 0, qualified: 0, not_qualified: 0, new_website: 0,
  website_improvement: 0, website_present: 0, manual_review: 0, ai_explained: 0, ai_pending: 0, ai_fallback: 0,
};

export function QualificationPage() {
  const [items, setItems] = useState<Qualification[]>([]);
  const [summary, setSummary] = useState<QualificationSummary>(emptySummary);
  const [filter, setFilter] = useState<(typeof filters)[number][0]>('all');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  usePolling(async () => {
    try {
      const opportunity = ['new_website', 'website_improvement', 'manual_review'].includes(filter) ? filter : undefined;
      const qualified = filter === 'actionable' ? true : undefined;
      const value = await api<{ qualifications: Qualification[]; summary: QualificationSummary; total: number }>(`/api/qualifications${queryString({ qualified, opportunity, limit: 100, offset: page * 100 })}`);
      setItems(value.qualifications); setTotal(value.total); setSummary(value.summary); setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  }, 5_000, `${filter}:${page}`);
  return <>
    <PageHeader eyebrow="LEAD PRIORITIZATION" title="Qualification" description="Evaluated is total classification progress. Qualified is the selected outreach subset. AI explanations run separately so they never block crawling, contact research, or enrichment." />
    <section className="stats-grid stats-grid-three">
      <StatCard label="Evaluated" value={summary.evaluated} note={`${summary.qualified} qualified · ${summary.not_qualified} not selected`} icon={BrainCircuit} />
      <StatCard label="Qualified leads" value={summary.qualified} note={`${summary.new_website} no website · ${summary.website_improvement} incomplete`} icon={CheckCircle2} tone="green" />
      <StatCard label="AI explanations" value={summary.ai_explained} note={`${summary.ai_pending} pending · ${summary.ai_fallback} rules fallback`} icon={Gauge} tone="violet" />
    </section>
    <Panel title="Ranked qualification results" subtitle="Weighted need, Bayesian-adjusted reputation, reachability, and evidence quality" action={<div className="segmented">{filters.map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => { setPage(0); setFilter(value); }}>{label}</button>)}</div>}>
      {error && <div className="alert">{error}</div>}
      <div className="qualification-list">{items.map((item) => {
        const breakdown = item.score_breakdown ?? {};
        const aiExplained = item.ai_status === 'completed';
        return <article key={item.id}>
          <Score value={item.score} />
          <div className="qualification-main">
            <div><Link to={`/businesses/${item.company_id}`}>{item.company_name}</Link><Badge value={item.priority_label ?? (item.qualified ? 'qualified' : 'skip')} /></div>
            <strong>{item.opportunity.replaceAll('_', ' ')} · #{item.run_rank} of {item.run_total} in run</strong>
            <p>{item.rationale ?? 'No rationale stored.'}</p>
            <div className="tag-list">{item.pain_points.map((point) => <span key={point}>{point}</span>)}</div>
            <div className="tag-list"><span>Need {breakdown.need ?? 0}</span><span>Business {breakdown.businessStrength ?? 0}</span><span>Reachability {breakdown.reachability ?? 0}</span><span>Evidence {breakdown.evidenceQuality ?? 0}</span>{breakdown.penalty ? <span>Penalty -{breakdown.penalty}</span> : null}</div>
          </div>
          <div className="qualification-meta"><small>Top {item.top_percent}% of run</small><strong>{item.recommended_role}</strong><span>{aiExplained ? 'AI explained' : item.ai_status === 'pending' ? 'AI pending · rules ranked' : 'Rules ranked'}</span><span>{item.contact_count} contacts · {item.email_count} emails</span><span>{item.city ?? item.country}</span></div>
        </article>;
      })}</div>
      {loading && <LoadingRows />}{!loading && !items.length && <EmptyState icon={BrainCircuit} title="No qualification results" detail="Results appear as website evidence is evaluated." />}
      <div className="pagination"><button className="button button-outline" disabled={!page} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page + 1} of {Math.max(1, Math.ceil(total / 100))} · {total} results</span><button className="button button-outline" disabled={(page + 1) * 100 >= total} onClick={() => setPage(page + 1)}>Next</button></div>
    </Panel>
  </>;
}
