import { Building2, CheckCircle2, MailCheck, Send, UsersRound } from 'lucide-react';
import { Link, useOutletContext } from 'react-router-dom';
import { useDashboard } from '../context/DashboardContext';
import { Badge, EmptyState, formatNumber, PageHeader, Panel, relativeTime, Score, StatCard } from '../components/Ui';
import type { Run } from '../api';

export function OverviewPage() {
  const { data, error } = useDashboard();
  const { openCreate } = useOutletContext<{ openCreate: () => void }>();
  const activeRun = data.runs.find((run) => ['queued', 'running'].includes(run.status)) ?? data.runs[0];
  return <>
    <PageHeader eyebrow="OPERATIONS CENTER" title="Pipeline overview" description="Follow businesses from first discovery through qualification and verified contact research." actions={<button className="button button-outline" onClick={openCreate}>Create a discovery</button>} />
    {error && <div className="alert">{error}</div>}
    <section className="stats-grid">
      <StatCard label="Businesses" value={data.overview.businesses} note="All discovered records" icon={Building2} />
      <StatCard label="Qualified" value={data.overview.qualified} note={ratio(data.overview.qualified, data.overview.businesses)} icon={CheckCircle2} tone="violet" />
      <StatCard label="Verified emails" value={data.overview.verified} note={ratio(data.overview.verified, data.overview.qualified)} icon={MailCheck} tone="cyan" />
      <StatCard label="Contacted" value={data.overview.contacted} note="Sending remains guarded" icon={Send} tone="green" />
    </section>
    <section className="dashboard-grid">
      <Panel title="Live pipeline" subtitle={activeRun ? activeRun.name : 'Create a discovery to begin'} action={activeRun && <Badge value={activeRun.status} />} className="pipeline-panel"><Pipeline run={activeRun} /></Panel>
      <Panel title="Queue pressure" subtitle="BullMQ · refreshes every 5 seconds"><QueuePressure queues={data.queues} /></Panel>
    </section>
    <section className="dashboard-grid dashboard-grid-wide">
      <Panel title="Latest leads" subtitle="Recently processed businesses" action={<Link className="text-link" to="/businesses">View all</Link>}><div className="table-wrap"><table><thead><tr><th>Business</th><th>Location</th><th>Opportunity</th><th>Score</th><th>Status</th></tr></thead><tbody>{data.leads.map((lead) => <tr key={lead.id}><td><Link className="table-title" to={`/businesses/${lead.id}`}>{lead.name}</Link><small>{lead.full_name ? `${lead.full_name} · ${lead.role ?? 'Contact'}` : lead.category ?? 'Uncategorized'}</small></td><td>{lead.city ?? lead.country}</td><td><span className="soft-tag">{lead.opportunity?.replaceAll('_', ' ') ?? 'Researching'}</span></td><td><Score value={lead.qualification_score ?? lead.filter_score} /></td><td><Badge value={lead.status} /></td></tr>)}</tbody></table>{!data.leads.length && <EmptyState icon={UsersRound} title="No leads yet" detail="Create a discovery run to populate this workspace." />}</div></Panel>
      <Panel title="Activity" subtitle="Worker and pipeline events"><div className="timeline">{data.events.map((event) => <div className="timeline-item" key={event.id}><span /><div><strong>{event.message}</strong><p>{event.company_name ?? event.run_name ?? event.stage}</p><time>{relativeTime(event.created_at)}</time></div></div>)}{!data.events.length && <EmptyState icon={CheckCircle2} title="No activity yet" detail="Events appear as workers process a run." />}</div></Panel>
    </section>
  </>;
}

function Pipeline({ run }: { run?: Run }) {
  const values = run?.stats ?? { discovered: 0, filtered: 0, qualified: 0, contacts: 0, verified: 0, contacted: 0 };
  const steps = [['Discovered', values.discovered], ['Filtered', values.filtered], ['Evaluated', run?.stats.evaluated ?? 0], ['Qualified', values.qualified], ['Contacts', values.contacts], ['Verified', values.verified], ['AI explained', run?.stats.ai_explained ?? 0]] as const;
  const max = Math.max(values.discovered, 1);
  return <div className="pipeline"><div className="pipeline-target"><span>Target volume</span><strong>{formatNumber(run?.target_count ?? 0)}</strong><small>{run ? `${run.business_types.join(', ')} across ${run.cities.join(', ')}` : 'No active market scope'}</small></div><div className="funnel">{steps.map(([label, value], index) => <div className="funnel-row" key={label}><div><span>{label}</span><strong>{formatNumber(value)}</strong></div><div className="track"><span style={{ width: `${Math.max(value ? 4 : 0, value / max * 100)}%`, opacity: 1 - index * .07 }} /></div></div>)}</div></div>;
}

function QueuePressure({ queues }: { queues: ReturnType<typeof useDashboard>['data']['queues'] }) {
  const entries = Object.entries(queues);
  if (!entries.length) return <EmptyState icon={CheckCircle2} title="Queues are connecting" detail="Queue counts will appear after Redis is ready." />;
  return <div className="queue-list">{entries.map(([name, counts]) => <div className="queue-row" key={name}><div><strong>{name}</strong><small>{counts.completed} recent done · {counts.failed} failed</small></div><div><b>{counts.waiting + counts.active + counts.delayed}</b><span>{counts.active ? `${counts.active} active` : 'pending'}</span></div></div>)}</div>;
}

function ratio(value: number, total: number) {
  return total ? `${Math.round(value / total * 100)}% of previous pool` : 'Awaiting data';
}
