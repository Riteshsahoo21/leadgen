import { Ban, Pause, Play } from 'lucide-react';
import { useState } from 'react';
import { api, type Run } from '../api';

export function RunControls({ run, onChange }: { run: Run; onChange: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!['queued', 'running', 'paused'].includes(run.status)) return null;
  async function act(action: 'pause' | 'resume' | 'cancel') {
    if (action === 'cancel' && !window.confirm(`Permanently stop ${run.name}? Saved leads stay. Use Pause if you want to resume later. A current external request may finish, but no further stages will start.`)) return;
    setBusy(true); setError('');
    try { await api(`/api/runs/${run.id}/${action}`, { method: 'POST' }); await onChange(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <div className="run-controls">
    <button className="button button-outline" disabled={busy} onClick={() => void act(run.status === 'paused' ? 'resume' : 'pause')}>
      {run.status === 'paused' ? <Play size={14} /> : <Pause size={14} />}{run.status === 'paused' ? 'Resume' : 'Pause'}
    </button>
    <button className="button button-outline danger" disabled={busy} onClick={() => void act('cancel')}><Ban size={14} /> Stop</button>
    {error && <small role="alert">{error}</small>}
  </div>;
}
