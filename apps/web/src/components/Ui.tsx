import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode }) {
  return <header className="page-header">
    <div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="page-description">{description}</p></div>
    {actions && <div className="page-actions">{actions}</div>}
  </header>;
}

export function Panel({ title, subtitle, action, children, className = '' }: { title?: string; subtitle?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}>
    {(title || action) && <div className="panel-header"><div>{title && <h2>{title}</h2>}{subtitle && <p>{subtitle}</p>}</div>{action}</div>}
    {children}
  </section>;
}

export function StatCard({ label, value, note, icon: Icon, tone = 'blue' }: { label: string; value: string | number; note: string; icon: LucideIcon; tone?: 'blue' | 'cyan' | 'violet' | 'green' }) {
  return <article className={`stat-card tone-${tone}`}>
    <div className="stat-card-top"><span>{label}</span><i><Icon size={17} /></i></div>
    <strong>{typeof value === 'number' ? formatNumber(value) : value}</strong>
    <small>{note}</small>
  </article>;
}

export function Badge({ value }: { value: string }) {
  return <span className={`badge badge-${value.toLowerCase().replaceAll('_', '-')}`}>{labelize(value)}</span>;
}

export function Score({ value }: { value?: number }) {
  return <span className={`score ${value !== undefined && value >= 75 ? 'score-high' : ''}`}>{value ?? '—'}</span>;
}

export function EmptyState({ icon: Icon, title, detail }: { icon: LucideIcon; title: string; detail: string }) {
  return <div className="empty-state"><i><Icon size={22} /></i><strong>{title}</strong><p>{detail}</p></div>;
}

export function LoadingRows({ count = 5 }: { count?: number }) {
  return <div className="loading-rows">{Array.from({ length: count }, (_, index) => <span key={index} />)}</div>;
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat('en', { notation: value >= 10_000 ? 'compact' : 'standard' }).format(value);
}

export function labelize(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

export function relativeTime(value: string) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
