import { ArrowLeft, ExternalLink, Globe2, Mail, MapPin, Phone, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Lead, type Message, type Qualification } from '../api';
import { Badge, EmptyState, LoadingRows, PageHeader, Panel, Score } from '../components/Ui';

type Detail = Lead & {
  qualification?: Qualification;
  website_evidence?: Record<string, unknown>;
  contacts: Array<{ id: string; full_name: string; role?: string; source_url?: string; confidence: number }>;
  emails: Array<{ id: string; email: string; verification_status: string; confidence: number; verification_method?: string }>;
  messages: Message[];
};

export function BusinessDetailPage() {
  const { id } = useParams();
  const [business, setBusiness] = useState<Detail>();
  const [error, setError] = useState('');
  useEffect(() => { api<{ business: Detail }>(`/api/businesses/${id}`).then((value) => setBusiness(value.business)).catch((reason) => setError(reason.message)); }, [id]);
  if (error) return <div className="alert">{error}</div>;
  if (!business) return <LoadingRows count={8} />;
  const evidence = business.website_evidence;
  return <>
    <Link className="back-link" to="/businesses"><ArrowLeft size={15} /> Back to businesses</Link>
    <PageHeader eyebrow={business.category ?? 'BUSINESS'} title={business.name} description={`${business.city ?? ''}${business.city ? ', ' : ''}${business.country}`} actions={<Badge value={business.status} />} />
    <section className="detail-grid">
      <Panel title="Business profile" subtitle="Discovery data"><div className="detail-list"><span><MapPin size={16} /><div><small>Address</small><strong>{business.address ?? 'Not available'}</strong></div></span><span><Phone size={16} /><div><small>Phone</small><strong>{business.phone ?? 'Not available'}</strong></div></span><span><Globe2 size={16} /><div><small>Website</small>{business.website ? <a href={business.website} target="_blank" rel="noreferrer">{business.domain ?? business.website}<ExternalLink size={13} /></a> : <strong>No website detected</strong>}</div></span></div></Panel>
      <Panel title="Qualification" subtitle={business.qualification?.model ?? 'Awaiting analysis'}><div className="qualification-summary"><Score value={business.qualification?.score} /><div><strong>{business.qualification?.opportunity?.replaceAll('_', ' ') ?? 'Not qualified yet'}</strong><p>{business.qualification?.rationale ?? 'This section fills when qualification completes.'}</p></div></div><div className="tag-list">{business.qualification?.pain_points?.map((item) => <span key={item}>{item}</span>)}</div></Panel>
    </section>
    <section className="detail-grid">
      <Panel title="Decision makers" subtitle="Public research candidates"><div className="record-list">{business.contacts.map((contact) => <div key={contact.id}><i><UserRound size={16} /></i><div><strong>{contact.full_name}</strong><small>{contact.role ?? 'Contact'} · {contact.confidence}% confidence</small></div>{contact.source_url && <a href={contact.source_url} target="_blank" rel="noreferrer"><ExternalLink size={15} /></a>}</div>)}{!business.contacts.length && <EmptyState icon={UserRound} title="No contact yet" detail="Public decision-maker research has not produced a candidate." />}</div></Panel>
      <Panel title="Email candidates" subtitle="Verification and evidence"><div className="record-list">{business.emails.map((email) => <div key={email.id}><i><Mail size={16} /></i><div><strong>{email.email}</strong><small>{email.verification_method ?? 'Unknown method'} · {email.confidence}% confidence</small></div><Badge value={email.verification_status} /></div>)}{!business.emails.length && <EmptyState icon={Mail} title="No email yet" detail="Email enrichment has not produced a candidate." />}</div></Panel>
    </section>
    <Panel title="Website evidence" subtitle="Compact signals retained from crawling"><pre className="evidence-block">{JSON.stringify(evidence ?? { note: 'No website evidence available' }, null, 2)}</pre></Panel>
  </>;
}
