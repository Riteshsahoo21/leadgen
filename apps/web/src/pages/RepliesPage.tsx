import { Inbox, MessageSquareReply } from 'lucide-react';
import { useState } from 'react';
import { api, type Message } from '../api';
import { Badge, EmptyState, LoadingRows, PageHeader, Panel, relativeTime } from '../components/Ui';
import { usePolling } from '../hooks/usePolling';

export function RepliesPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  usePolling(async () => {
    const value = await api<{ messages: Message[] }>('/api/messages?direction=inbound&limit=200');
    setMessages(value.messages); setLoading(false);
  });
  return <><PageHeader eyebrow="REPLY INBOX" title="Replies" description="Inbound responses, classifications, and suppression outcomes from Posta webhooks." /><Panel title="Inbound messages" subtitle="Replies are classified and future outreach stops automatically"><div className="reply-list">{messages.map((message) => <article key={message.id}><div className="reply-avatar"><MessageSquareReply size={18} /></div><div><div><strong>{message.full_name}</strong><span>{message.email}</span><Badge value={message.reply_category ?? 'needs_human'} /></div><h3>{message.subject || '(no subject)'}</h3><p>{message.body}</p><small>{message.company_name} · {relativeTime(message.created_at)}</small></div></article>)}</div>{loading && <LoadingRows />}{!loading && !messages.length && <EmptyState icon={Inbox} title="No replies yet" detail="Inbound replies will appear once Posta is configured and sending is enabled." />}</Panel></>;
}
