import { BrainCircuit, CheckCircle2, Gauge } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, queryString, type Qualification } from '../api';
import { Badge, EmptyState, LoadingRows, PageHeader, Panel, Score, StatCard } from '../components/Ui';
import { usePolling } from '../hooks/usePolling';

const filters = [
  ['actionable', 'Actionable'],
  ['new_website', 'No website'],
  ['website_improvement', 'Incomplete website'],
  ['manual_review', 'Manual review'],
  ['all', 'All'],
] as const;

export function QualificationPage() {
  const [items, setItems] = useState<Qualification[]>([]);
  const [filter, setFilter] = useState<(typeof filters)[number][0]>('actionable');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  usePolling(async () => {
    try {
      const opportunity = ['new_website', 'website_improvement', 'manual_review'].includes(filter) ? filter : undefined;
      const qualified = filter === 'actionable' ? true : undefined;
      const value = await api<{ qualifications: Qualification[] }>(`/api/qualifications${queryString({ qualified, opportunity, limit: 200 })}`);
      setItems(value.qualifications); setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  }, 5_000, filter);
  const stats = useMemo(() => ({
    qualified: items.filter((item) => item.qualified).length,
    contactNow: items.filter((item) => item.priority_label === 'contact_now').length,
    average: items.length ? Math.round(items.reduce((sum, item) => sum + item.score, 0) / items.length) : 0,
  }), [items]);
  return <>
    <PageHeader eyebrow="LEAD PRIORITIZATION" title="Qualification" description="Businesses are ranked against others in their discovery run using website need, Bayesian-adjusted reputation, reachability, and evidence quality." />
    <section className="stats-grid stats-grid-three"><StatCard label="Visible leads" value={items.length} note="Current ranked result" icon={BrainCircuit} /><StatCard label="Contact now" value={stats.contactNow} note="Highest-priority qualified leads" icon={CheckCircle2} tone="green" /><StatCard label="Average score" value={stats.average} note={`${stats.qualified} qualified in this view`} icon={Gauge} tone="violet" /></section>
    <Panel title="Ranked qualification results" subtitle="No-website and incomplete-website opportunities are separated from complete sites" action={<div className="segmented">{filters.map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div>}>
      {error && <div className="alert">{error}</div>}
      <div className="qualification-list">{items.map((item) => {
        const breakdown = item.score_breakdown ?? {};
        return <article key={item.id}>
          <Score value={item.score} />
          <div className="qualification-main">
            <div><Link to={`/businesses/${item.company_id}`}>{item.company_name}</Link><Badge value={item.priority_label ?? (item.qualified ? 'qualified' : 'skip')} /></div>
            <strong>{item.opportunity.replaceAll('_', ' ')} · #{item.run_rank} of {item.run_total} in run</strong>
            <p>{item.rationale ?? 'No rationale stored.'}</p>
            <div className="tag-list">{item.pain_points.map((point) => <span key={point}>{point}</span>)}</div>
            <div className="tag-list"><span>Need {breakdown.need ?? 0}</span><span>Business {breakdown.businessStrength ?? 0}</span><span>Reachability {breakdown.reachability ?? 0}</span><span>Evidence {breakdown.evidenceQuality ?? 0}</span>{breakdown.penalty ? <span>Penalty −{breakdown.penalty}</span> : null}</div>
          </div>
          <div className="qualification-meta"><small>Top {item.top_percent}% of run</small><strong>{item.recommended_role}</strong><span>{item.contact_count} contacts · {item.email_count} emails</span><span>{item.city ?? item.country}</span></div>
        </article>;
      })}</div>
      {loading && <LoadingRows />}{!loading && !items.length && <EmptyState icon={BrainCircuit} title="No qualification results" detail="Results appear as website analysis finishes." />}
    </Panel>
  </>;
}
