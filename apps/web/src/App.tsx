import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api, getToken, setToken as persistToken, type Lead, type OverviewResponse, type Run } from './api';

const emptyOverview: OverviewResponse = {
  overview: { businesses: 0, qualified: 0, verified: 0, contacted: 0, active_runs: 0 },
  queues: {}, runs: [], leads: [], events: [],
};

export default function App() {
  const [data, setData] = useState(emptyOverview);
  const [token, setToken] = useState(getToken());
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async (quiet = false) => {
    if (!getToken()) return;
    if (!quiet) setLoading(true);
    try {
      const next = await api<OverviewResponse>('/api/overview');
      setData(next); setAuthenticated(true); setError('');
    } catch (reason) {
      setAuthenticated(false); setError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (!quiet) setLoading(false); }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  function connect(event: FormEvent) {
    event.preventDefault(); persistToken(token.trim()); void load();
  }

  if (!authenticated) return <Login token={token} setToken={setToken} connect={connect} loading={loading} error={error} />;

  const activeRun = data.runs.find((run) => ['queued', 'running'].includes(run.status)) ?? data.runs[0];
  return (
    <div className="app-shell">
      <Sidebar onCreate={() => setShowCreate(true)} />
      <main className="main">
        <header className="topbar">
          <div><p className="eyebrow">OPERATIONS CENTER</p><h1>Pipeline overview</h1></div>
          <div className="top-actions"><SystemPulse active={data.overview.active_runs > 0} /><button className="primary compact" onClick={() => setShowCreate(true)}>＋ New discovery</button></div>
        </header>

        {error && <div className="alert">{error}</div>}
        <section className="stats-grid">
          <Metric label="Businesses" value={data.overview.businesses} change="All discovered" icon="⌂" />
          <Metric label="Qualified" value={data.overview.qualified} change={ratio(data.overview.qualified, data.overview.businesses)} icon="◇" accent />
          <Metric label="Verified emails" value={data.overview.verified} change={ratio(data.overview.verified, data.overview.qualified)} icon="✉" />
          <Metric label="Contacted" value={data.overview.contacted} change="Sending guarded" icon="↗" />
        </section>

        <section className="content-grid">
          <div className="panel pipeline-panel">
            <PanelHeader title="Live pipeline" subtitle={activeRun ? activeRun.name : 'Create a discovery to begin'} action={<span className={`status ${activeRun?.status ?? 'idle'}`}>{activeRun?.status ?? 'idle'}</span>} />
            <Pipeline run={activeRun} />
          </div>
          <div className="panel queue-panel">
            <PanelHeader title="Queue pressure" subtitle="BullMQ · refreshes every 5s" />
            <QueuePressure queues={data.queues} />
          </div>
        </section>

        <section className="content-grid lower">
          <div className="panel leads-panel">
            <PanelHeader title="Latest leads" subtitle="Most recently processed companies" action={<button className="text-button">View all →</button>} />
            <LeadTable leads={data.leads} />
          </div>
          <div className="panel activity-panel">
            <PanelHeader title="Activity" subtitle="Worker and campaign events" />
            <Activity events={data.events} />
          </div>
        </section>

        <section className="panel runs-panel">
          <PanelHeader title="Discovery runs" subtitle="Input scope and current yield" />
          <Runs runs={data.runs} />
        </section>
      </main>
      {showCreate && <CreateRun onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); void load(); }} />}
    </div>
  );
}

function Login({ token, setToken, connect, loading, error }: { token: string; setToken: (v:string)=>void; connect:(e:FormEvent)=>void; loading:boolean; error:string }) {
  return <div className="login-page"><div className="login-art"><div className="brand large"><span className="brand-mark">LF</span><span>LeadForge</span></div><h1>Turn local business signals into a focused pipeline.</h1><p>Self-hosted research, qualification, enrichment, and outreach—with every stage under your control.</p><div className="orb orb-one"/><div className="orb orb-two"/></div><form className="login-card" onSubmit={connect}><p className="eyebrow">SECURE ACCESS</p><h2>Connect to your workspace</h2><p>Enter the <code>API_TOKEN</code> from your VPS environment file.</p><label>API token<input autoFocus type="password" value={token} onChange={(e)=>setToken(e.target.value)} placeholder="Your private API token" required /></label>{error && <div className="field-error">{error}</div>}<button className="primary" disabled={loading}>{loading ? 'Connecting…' : 'Open dashboard →'}</button><small>The token stays in this browser.</small></form></div>;
}

function Sidebar({ onCreate }: { onCreate: () => void }) {
  return <aside className="sidebar"><div className="brand"><span className="brand-mark">LF</span><span>LeadForge</span></div><nav><a className="active">▦ <span>Overview</span></a><a>⌕ <span>Businesses</span></a><a>◇ <span>Qualification</span></a><a>✉ <span>Campaigns</span></a><a>☷ <span>Replies</span></a></nav><div className="sidebar-bottom"><button className="primary" onClick={onCreate}>＋ New discovery</button><div className="resource-note"><span className="pulse-dot"/><div><strong>Resource guard active</strong><small>8 GB VPS profile</small></div></div></div></aside>;
}

function Metric({ label, value, change, icon, accent=false }: { label:string; value:number; change:string; icon:string; accent?:boolean }) {
  return <article className={`metric ${accent ? 'accent' : ''}`}><div className="metric-top"><span>{label}</span><i>{icon}</i></div><strong>{format(value)}</strong><small>{change}</small></article>;
}

function PanelHeader({ title, subtitle, action }: { title:string; subtitle:string; action?:React.ReactNode }) {
  return <div className="panel-header"><div><h2>{title}</h2><p>{subtitle}</p></div>{action}</div>;
}

function Pipeline({ run }: { run?: Run }) {
  const values = run?.stats ?? { discovered:0,filtered:0,qualified:0,contacts:0,verified:0,contacted:0 };
  const steps = [
    ['Discovered', values.discovered], ['Filtered', values.filtered], ['Qualified', values.qualified],
    ['Contacts', values.contacts], ['Verified', values.verified], ['Contacted', values.contacted],
  ] as const;
  const max = Math.max(values.discovered, 1);
  return <div className="pipeline"><div className="pipeline-target"><span>Target</span><strong>{format(run?.target_count ?? 0)}</strong><small>{run ? `${run.business_types.join(', ')} · ${run.cities.join(', ')}` : 'No active scope'}</small></div><div className="funnel">{steps.map(([label,value], index)=><div className="funnel-row" key={label}><div className="funnel-label"><span>{label}</span><strong>{format(value)}</strong></div><div className="track"><div className="fill" style={{width:`${Math.max(value ? 4 : 0,(value/max)*100)}%`, opacity:1-index*0.08}}/></div></div>)}</div></div>;
}

function QueuePressure({ queues }: { queues: OverviewResponse['queues'] }) {
  const entries = Object.entries(queues);
  if (!entries.length) return <Empty text="Queues are connecting…"/>;
  return <div className="queue-list">{entries.map(([name,counts])=>{const load=counts.waiting+counts.active; return <div className="queue-row" key={name}><div><span className="queue-name">{name}</span><small>{counts.completed} done · {counts.failed} failed</small></div><div className="queue-count"><strong>{load}</strong><span>{counts.active ? `${counts.active} active` : 'waiting'}</span></div></div>})}</div>;
}

function LeadTable({ leads }: { leads: Lead[] }) {
  if (!leads.length) return <Empty text="Your processed leads will appear here."/>;
  return <div className="table-wrap"><table><thead><tr><th>Business</th><th>Location</th><th>Opportunity</th><th>Score</th><th>Status</th></tr></thead><tbody>{leads.map((lead)=><tr key={lead.id}><td><strong>{lead.name}</strong><small>{lead.full_name ? `${lead.full_name} · ${lead.role ?? 'Contact'}` : lead.category ?? 'Uncategorized'}</small></td><td>{lead.city ?? lead.country}</td><td><span className="soft-tag">{labelize(lead.opportunity ?? 'researching')}</span></td><td><span className="score">{lead.qualification_score ?? lead.filter_score ?? '—'}</span></td><td><span className={`status ${lead.status}`}>{labelize(lead.status)}</span></td></tr>)}</tbody></table></div>;
}

function Activity({ events }: { events: OverviewResponse['events'] }) {
  if (!events.length) return <Empty text="Worker activity will appear here."/>;
  return <div className="timeline">{events.slice(0,9).map((event)=><div className="timeline-item" key={event.id}><span className="timeline-dot"/><div><strong>{event.message}</strong><p>{event.company_name ?? event.run_name ?? labelize(event.stage)}</p><time>{relative(event.created_at)}</time></div></div>)}</div>;
}

function Runs({ runs }: { runs: Run[] }) {
  if (!runs.length) return <Empty text="No discovery runs yet."/>;
  return <div className="run-cards">{runs.map((run)=><div className="run-card" key={run.id}><div><strong>{run.name}</strong><small>{run.business_types.join(', ')} in {run.cities.join(', ')}, {run.country}</small></div><div className="run-yield"><span>{format(run.stats?.qualified ?? 0)} qualified</span><span className={`status ${run.status}`}>{run.status}</span></div></div>)}</div>;
}

function CreateRun({ onClose, onCreated }: { onClose:()=>void; onCreated:()=>void }) {
  const [form,setForm]=useState({name:'India growth list',country:'India',cities:'Mumbai, Bangalore, Bhubaneswar',businessTypes:'dentist, agency, clinic, manufacturer',targetCount:5000});
  const [error,setError]=useState(''); const [busy,setBusy]=useState(false);
  const queries=useMemo(()=>form.cities.split(',').filter(Boolean).length*form.businessTypes.split(',').filter(Boolean).length,[form]);
  async function submit(event:FormEvent){event.preventDefault();setBusy(true);setError('');try{await api('/api/runs',{method:'POST',body:JSON.stringify(form)});onCreated();}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}finally{setBusy(false)}}
  return <div className="modal-backdrop" onMouseDown={(e)=>{if(e.target===e.currentTarget)onClose()}}><form className="modal" onSubmit={submit}><div className="modal-head"><div><p className="eyebrow">NEW DISCOVERY</p><h2>Define your market</h2><p>Comma-separated fields become parallel search jobs.</p></div><button type="button" className="close" onClick={onClose}>×</button></div><div className="form-grid"><label className="span-2">Run name<input value={form.name} onChange={(e)=>setForm({...form,name:e.target.value})} required /></label><label>Country<input value={form.country} onChange={(e)=>setForm({...form,country:e.target.value})} placeholder="India" required /></label><label>Target businesses<input type="number" min="1" max="50000" value={form.targetCount} onChange={(e)=>setForm({...form,targetCount:Number(e.target.value)})} required /></label><label className="span-2">Cities<textarea value={form.cities} onChange={(e)=>setForm({...form,cities:e.target.value})} placeholder="Mumbai, Pune, Bangalore" required/><small>Enter one or many cities, separated by commas.</small></label><label className="span-2">Business types<textarea value={form.businessTypes} onChange={(e)=>setForm({...form,businessTypes:e.target.value})} placeholder="dentist, clinic, restaurant, agency" required/><small>Any niche is supported; duplicates are removed automatically.</small></label></div><div className="query-preview"><span>⌘</span><div><strong>{queries} discovery queries</strong><small>Stages overlap automatically; browser and AI stay at concurrency 1.</small></div></div>{error&&<div className="field-error">{error}</div>}<div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy?'Creating…':'Start discovery →'}</button></div></form></div>;
}

function SystemPulse({ active }: { active:boolean }) { return <div className="system-pulse"><span className={active?'pulse-dot':'idle-dot'}/><div><strong>{active?'Pipeline running':'System ready'}</strong><small>{active?'Workers processing':'Awaiting discovery'}</small></div></div> }
function Empty({text}:{text:string}){return <div className="empty">{text}</div>}
function format(value:number){return new Intl.NumberFormat('en',{notation:value>=10000?'compact':'standard'}).format(value)}
function ratio(value:number,total:number){return total?`${Math.round(value/total*100)}% of previous pool`:'Awaiting data'}
function labelize(value:string){return value.replaceAll('_',' ').replace(/\b\w/g,(c)=>c.toUpperCase())}
function relative(value:string){const seconds=Math.round((Date.now()-new Date(value).getTime())/1000);if(seconds<60)return `${Math.max(0,seconds)}s ago`;if(seconds<3600)return `${Math.floor(seconds/60)}m ago`;if(seconds<86400)return `${Math.floor(seconds/3600)}h ago`;return `${Math.floor(seconds/86400)}d ago`}
