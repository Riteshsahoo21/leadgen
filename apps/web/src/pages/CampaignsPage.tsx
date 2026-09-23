import { FileText, LockKeyhole, Mail } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type AppConfig, type Message } from '../api';
import { Badge, EmptyState, LoadingRows, PageHeader, Panel, relativeTime } from '../components/Ui';

export function CampaignsPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [config, setConfig] = useState<AppConfig>();
  const [loading, setLoading] = useState(true);
  useEffect(() => { Promise.all([api<{ messages: Message[] }>('/api/messages?direction=outbound&limit=200'), api<AppConfig>('/api/config')]).then(([messageResult, configResult]) => { setMessages(messageResult.messages); setConfig(configResult); }).finally(() => setLoading(false)); }, []);
  return <>
    <PageHeader eyebrow="OUTREACH WORKSPACE" title="Campaigns" description="Review generated drafts and delivery state. Sending stays locked until mail services are explicitly enabled." />
    <div className={`safety-banner ${config?.emailSending ? 'safety-live' : ''}`}><LockKeyhole size={20} /><div><strong>{config?.emailSending ? 'Email sending enabled' : 'Email sending is safely disabled'}</strong><p>{config?.emailSending ? `Daily limit: ${config.dailySendLimit}` : 'Research and enrichment work normally, but no email can leave this system.'}</p></div><Badge value={config?.pipelineStopAfter ?? 'loading'} /></div>
    <Panel title="Outbound messages" subtitle="Drafts and sent records created by the campaign queue"><div className="message-list">{messages.map((message) => <article key={message.id}><i><Mail size={17} /></i><div><div><strong>{message.subject ?? 'Untitled message'}</strong><Badge value={message.status} /></div><p>To {message.full_name} at {message.company_name} · {message.email}</p><small>{relativeTime(message.created_at)}</small></div></article>)}</div>{loading && <LoadingRows />}{!loading && !messages.length && <EmptyState icon={FileText} title="No campaign drafts" detail="The current safe pipeline stops after enrichment. Switch the stop stage to draft when you are ready to generate messages." />}</Panel>
  </>;
}
