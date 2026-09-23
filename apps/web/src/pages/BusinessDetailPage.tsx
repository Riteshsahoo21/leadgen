import {
  ArrowLeft, ExternalLink, Globe2, Mail, MapPin, Phone, RefreshCw, Share2, UserRound,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Lead, type Message, type Qualification } from '../api';
import { Badge, EmptyState, LoadingRows, PageHeader, Panel, Score } from '../components/Ui';

type ContactSource = {
  kind: 'email' | 'phone' | 'social';
  value: string;
  sourceType: string;
  sourceUrl?: string;
};

type Detail = Lead & {
  qualification?: Qualification;
  website_evidence?: {
    emails?: string[];
    phones?: string[];
    social_links?: string[];
    contact_sources?: ContactSource[];
    evidence?: { publicContactSources?: ContactSource[] };
    [key: string]: unknown;
  };
  contacts: Array<{ id: string; full_name: string; role?: string; source_url?: string; confidence: number }>;
  emails: Array<{
    id: string;
    email: string;
    verification_status: string;
    confidence: number;
    verification_method?: string;
    evidence?: { sourceType?: string; sourceUrl?: string; public?: boolean };
  }>;
  messages: Message[];
};

type EmailRow = {
  email: string;
  status: string;
  confidence: number;
  method: string;
  sourceType?: string;
  sourceUrl?: string;
};

export function BusinessDetailPage() {
  const { id } = useParams();
  const [business, setBusiness] = useState<Detail>();
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(() => api<{ business: Detail }>(`/api/businesses/${id}`)
    .then((value) => setBusiness(value.business))
    .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))), [id]);
  useEffect(() => { void load(); }, [load]);

  if (error) return <div className="alert">{error}</div>;
  if (!business) return <LoadingRows count={8} />;

  const evidence = business.website_evidence;
  const storedSources = evidence?.contact_sources ?? evidence?.evidence?.publicContactSources ?? [];
  const mapsEmails = parseProviderList(business.raw_data?.emails);
  const publicEmails = [...new Set([...(evidence?.emails ?? []), ...mapsEmails])];
  const phoneValues = [...new Set([business.phone, ...(evidence?.phones ?? [])].filter(Boolean) as string[])];
  const socialValues = [...new Set(evidence?.social_links ?? [])];
  const emailRows = buildEmailRows(business.emails, publicEmails, storedSources);

  const refreshResearch = async () => {
    setRefreshing(true);
    try {
      await api(`/api/businesses/${business.id}/research`, { method: 'POST', body: '{}' });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRefreshing(false);
    }
  };

  return <>
    <Link className="back-link" to="/businesses"><ArrowLeft size={15} /> Back to businesses</Link>
    <PageHeader
      eyebrow={business.category ?? 'BUSINESS'}
      title={business.name}
      description={`${business.city ?? ''}${business.city ? ', ' : ''}${business.country}`}
      actions={<><Badge value={business.status} /><button className="button button-secondary" disabled={refreshing} onClick={refreshResearch}><RefreshCw size={14} />{refreshing ? 'Queued…' : 'Refresh contacts'}</button></>}
    />

    <section className="detail-grid">
      <Panel title="Business profile" subtitle="Discovery data">
        <div className="detail-list">
          <span><MapPin size={16} /><div><small>Address</small><strong>{business.address ?? 'Not available'}</strong></div></span>
          <span><Phone size={16} /><div><small>Primary phone</small><strong>{business.phone ?? 'Not available'}</strong></div></span>
          <span><Globe2 size={16} /><div><small>Website</small>{business.website ? <a href={business.website} target="_blank" rel="noreferrer">{business.domain ?? business.website}<ExternalLink size={13} /></a> : <strong>No website detected</strong>}</div></span>
        </div>
      </Panel>
      <Panel title="Why this is a potential client" subtitle={business.qualification?.model ?? 'Awaiting AI analysis'}>
        <div className="qualification-summary"><Score value={business.qualification?.score} /><div><strong>{business.qualification?.opportunity?.replaceAll('_', ' ') ?? 'Not evaluated yet'}</strong><p>{business.qualification?.rationale ?? 'AI will explain the observed business and website signals here without inventing facts.'}</p></div></div>
        <div className="tag-list">{business.qualification?.pain_points?.map((item) => <span key={item}>{item}</span>)}{business.filter_reasons?.map((item) => <span key={item}>{item}</span>)}</div>
      </Panel>
    </section>

    <section className="detail-grid">
      <Panel title="Decision makers" subtitle="Public research candidates">
        <div className="record-list">{business.contacts.map((contact) => <div key={contact.id}><i><UserRound size={16} /></i><div><strong>{contact.full_name}</strong><small>{contact.role ?? 'Contact'} · {contact.confidence}% confidence</small></div>{contact.source_url && <a href={contact.source_url} target="_blank" rel="noreferrer"><ExternalLink size={15} /></a>}</div>)}{!business.contacts.length && <EmptyState icon={UserRound} title="No named contact yet" detail="Public contact channels can still appear even when an owner name is unavailable." />}</div>
      </Panel>
      <Panel title="Public phones & social profiles" subtitle="Maps, website and public-search evidence">
        <div className="record-list">
          {phoneValues.map((phone) => {
            const source = storedSources.find((item) => item.kind === 'phone' && digits(item.value) === digits(phone));
            return <div key={phone}><i><Phone size={16} /></i><div><strong>{phone}</strong><small>{sourceLabel(source?.sourceType ?? (phone === business.phone ? 'google_maps' : 'company_website'))}</small></div>{source?.sourceUrl && <a href={source.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} /></a>}</div>;
          })}
          {socialValues.map((url) => <div key={url}><i><Share2 size={16} /></i><div><strong>{socialName(url)}</strong><small>Public social profile</small></div><a href={url} target="_blank" rel="noreferrer"><ExternalLink size={15} /></a></div>)}
          {!phoneValues.length && !socialValues.length && <EmptyState icon={Phone} title="No public channel yet" detail="Refresh contact research to search Maps, the company website and public social evidence." />}
        </div>
      </Panel>
    </section>

    <section className="detail-section"><Panel title="Email candidates" subtitle="Observed addresses stay separate from generated patterns">
      <div className="record-list">{emailRows.map((email) => <div key={email.email}><i><Mail size={16} /></i><div><strong>{email.email}</strong><small>{sourceLabel(email.sourceType ?? email.method)} · {email.confidence}% confidence</small></div>{email.sourceUrl && <a href={email.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} /></a>}<Badge value={email.status} /></div>)}{!emailRows.length && <EmptyState icon={Mail} title="No public email yet" detail="Contact research checks Google Maps output, the company site, search snippets and public social profiles." />}</div>
    </Panel></section>

    <section className="detail-section"><Panel title="Website evidence" subtitle="Compact signals retained from crawling"><pre className="evidence-block">{JSON.stringify(evidence ?? { note: 'No website evidence available' }, null, 2)}</pre></Panel></section>
  </>;
}

function buildEmailRows(stored: Detail['emails'], publicEmails: string[], sources: ContactSource[]): EmailRow[] {
  const rows = new Map<string, EmailRow>();
  for (const email of stored) rows.set(email.email.toLowerCase(), {
    email: email.email, status: email.verification_status, confidence: email.confidence,
    method: email.verification_method ?? 'Public evidence',
    ...(email.evidence?.sourceType ? { sourceType: email.evidence.sourceType } : {}),
    ...(email.evidence?.sourceUrl ? { sourceUrl: email.evidence.sourceUrl } : {}),
  });
  for (const email of publicEmails) {
    if (rows.has(email.toLowerCase())) continue;
    const source = sources.find((item) => item.kind === 'email' && item.value.toLowerCase() === email.toLowerCase());
    rows.set(email.toLowerCase(), {
      email, status: 'public', confidence: ['google_maps', 'company_website'].includes(source?.sourceType ?? '') ? 90 : 70,
      method: 'Public evidence', ...(source?.sourceType ? { sourceType: source.sourceType } : {}),
      ...(source?.sourceUrl ? { sourceUrl: source.sourceUrl } : {}),
    });
  }
  return [...rows.values()];
}

function parseProviderList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || !value.trim() || value.trim() === '[]') return [];
  try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed.map(String) : []; }
  catch { return value.split(/[;,\n]/).map((item) => item.trim()).filter(Boolean); }
}

function sourceLabel(value: string) {
  const labels: Record<string, string> = {
    google_maps: 'Google Maps', company_website: 'Company website', public_search: 'Public search result',
    social_search: 'Public social profile', generated_pattern: 'Generated pattern', pattern_and_mx: 'Generated pattern + MX',
  };
  return labels[value] ?? value.replaceAll('_', ' ');
}

function socialName(value: string) {
  try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return value; }
}

function digits(value: string) { return value.replace(/\D/g, ''); }
