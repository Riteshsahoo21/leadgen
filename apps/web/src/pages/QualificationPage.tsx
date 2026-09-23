import { BrainCircuit, CheckCircle2, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, queryString, type Qualification } from '../api';
import { Badge, EmptyState, LoadingRows, PageHeader, Panel, Score, StatCard } from '../components/Ui';

export function QualificationPage() {
  const [items, setItems] = useState<Qualification[]>([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => { setLoading(true); api<{ qualifications: Qualification[] }>(`/api/qualifications${queryString({ qualified: filter === 'all' ? undefined : filter === 'qualified', limit: 200 })}`).then((value) => setItems(value.qualifications)).catch((reason) => setError(reason.message)).finally(() => setLoading(false)); }, [filter]);
  const stats = useMemo(() => ({ qualified: items.filter((item) => item.qualified).length, rejected: items.filter((item) => !item.qualified).length, average: items.length ? Math.round(items.reduce((sum, item) => sum + item.score, 0) / items.length) : 0 }), [items]);
  return <>
    <PageHeader eyebrow="AI EVALUATION" title="Qualification" description="Review prioritized opportunities and the stored evidence behind each score." />
    <section className="stats-grid stats-grid-three"><StatCard label="Evaluated" value={items.length} note="Current filtered result" icon={BrainCircuit} /><StatCard label="Qualified" value={stats.qualified} note="Meets the configured threshold" icon={CheckCircle2} tone="green" /><StatCard label="Average score" value={stats.average} note="Across visible evaluations" icon={XCircle} tone="violet" /></section>
    <Panel title="Qualification results" subtitle="AI or deterministic safe-mode decisions" action={<div className="segmented"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button><button className={filter === 'qualified' ? 'active' : ''} onClick={() => setFilter('qualified')}>Qualified</button><button className={filter === 'rejected' ? 'active' : ''} onClick={() => setFilter('rejected')}>Not qualified</button></div>}>
      {error && <div className="alert">{error}</div>}<div className="qualification-list">{items.map((item) => <article key={item.id}><Score value={item.score} /><div className="qualification-main"><div><Link to={`/businesses/${item.company_id}`}>{item.company_name}</Link><Badge value={item.qualified ? 'qualified' : 'unqualified'} /></div><strong>{item.opportunity.replaceAll('_', ' ')}</strong><p>{item.rationale ?? 'No rationale stored.'}</p><div className="tag-list">{item.pain_points.map((point) => <span key={point}>{point}</span>)}</div></div><div className="qualification-meta"><small>Recommended contact</small><strong>{item.recommended_role}</strong><span>{item.city ?? item.country}</span></div></article>)}</div>{loading && <LoadingRows />}{!loading && !items.length && <EmptyState icon={BrainCircuit} title="No qualification results" detail="Results appear as the AI queue evaluates businesses." />}
    </Panel>
  </>;
}
