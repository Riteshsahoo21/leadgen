import { Bot, Database, Mail, Network, Server, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { api, type AppConfig } from '../api';
import { Badge, LoadingRows, PageHeader, Panel } from '../components/Ui';
import { usePolling } from '../hooks/usePolling';

export function SettingsPage() {
  const [config, setConfig] = useState<AppConfig>();
  const [health, setHealth] = useState<{ status: string; databaseTime: string; mode: string }>();
  usePolling(async () => {
    const [configResult, healthResult] = await Promise.all([api<AppConfig>('/api/config'), fetch('/health').then((response) => response.json())]);
    setConfig(configResult); setHealth(healthResult);
  }, 10_000);
  if (!config) return <LoadingRows count={7} />;
  return <><PageHeader eyebrow="SYSTEM CONTROL" title="Settings" description="Read-only production configuration. Sensitive values remain exclusively in the VPS environment file." /><section className="settings-grid"><Panel title="Pipeline mode" subtitle="Provider and stage guardrails"><SettingRow icon={Network} label="Provider mode" value={config.providerMode} badge /><SettingRow icon={Bot} label="Stop after" value={config.pipelineStopAfter} badge /><SettingRow icon={ShieldCheck} label="Qualification threshold" value={`${config.qualificationThreshold}/100`} /></Panel><Panel title="Capacity" subtitle="Bounded operating limits"><SettingRow icon={Server} label="Discovery result cap" value={config.maxDiscoveryResults.toLocaleString()} /><SettingRow icon={Mail} label="Email daily limit" value={config.dailySendLimit.toLocaleString()} /><SettingRow icon={Database} label="Database" value={health?.status === 'ok' ? 'Connected' : 'Checking'} badge /></Panel></section><Panel title="Safety status" subtitle="Production locks and exposure"><div className="safety-grid"><div><ShieldCheck size={20} /><span><strong>API authentication</strong><small>Bearer token required for every dashboard request</small></span><Badge value="active" /></div><div><Mail size={20} /><span><strong>Email delivery</strong><small>No message leaves unless both provider and sending locks are enabled</small></span><Badge value={config.emailSending ? 'enabled' : 'disabled'} /></div><div><Server size={20} /><span><strong>Private services</strong><small>PostgreSQL, Redis, SearXNG, Ollama, and Maps stay off the public network</small></span><Badge value="active" /></div></div></Panel></>;
}

function SettingRow({ icon: Icon, label, value, badge = false }: { icon: typeof Server; label: string; value: string; badge?: boolean }) {
  return <div className="setting-row"><i><Icon size={17} /></i><span><small>{label}</small><strong>{value}</strong></span>{badge && <Badge value={value} />}</div>;
}
