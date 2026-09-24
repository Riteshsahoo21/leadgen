import { maybeCompleteRun, pool, refreshRunStats } from './db.js';
import { enqueue, type QueueName } from './queues.js';

export const stageQueues: Record<string, QueueName> = {
  discovered: 'filter', crawl_queued: 'crawl', qualify_queued: 'qualify',
  research_queued: 'research', enrich_queued: 'enrich', campaign_queued: 'campaign',
};

// PostgreSQL owns progress. Reconcile in bounded pages after a restart or a
// Redis/network failure; simple BullMQ deduplication protects active work.
export async function reconcileRun(runId: string) {
  const run = (await pool.query(`SELECT * FROM discovery_runs WHERE id=$1 AND status IN ('running','queued')`, [runId])).rows[0];
  if (!run) return;
  if (!run.discovery_finished_at) await enqueue('discovery', 'discover-businesses', { runId }, `discovery:${runId}`);
  let cursor = '00000000-0000-0000-0000-000000000000';
  while (true) {
    const result = await pool.query(`SELECT c.id,c.status,q.ai_status,
      (SELECT id FROM contacts WHERE company_id=c.id ORDER BY confidence DESC LIMIT 1) AS contact_id,
      (SELECT id FROM contact_emails WHERE company_id=c.id AND verification_status='valid' ORDER BY confidence DESC LIMIT 1) AS email_id
      FROM companies c LEFT JOIN qualifications q ON q.company_id=c.id
      WHERE c.run_id=$1 AND c.id>$2 AND (c.status=ANY($3::text[]) OR q.ai_status='pending')
      ORDER BY c.id LIMIT 100`, [runId, cursor, Object.keys(stageQueues)]);
    if (!result.rows.length) break;
    for (const company of result.rows) {
      const data = { runId, companyId: company.id, contactId: company.contact_id, emailId: company.email_id };
      const stage = stageQueues[company.status];
      if (stage) await enqueue(stage, `recover-${stage}`, data, `${stage}:${company.id}`);
      if (company.ai_status === 'pending') await enqueue('ai', 'explain-qualification', data, `ai:${company.id}`);
    }
    cursor = result.rows.at(-1).id;
  }
  await refreshRunStats(runId);
  await maybeCompleteRun(runId);
}

export async function reconcileActiveRuns() {
  // Reopen stale 'completed' runs only when actual unfinished work exists.
  await pool.query(`UPDATE discovery_runs r SET status='running',completed_at=NULL
    WHERE r.status='completed' AND (
      EXISTS (SELECT 1 FROM companies c WHERE c.run_id=r.id AND c.status=ANY($1::text[])) OR
      EXISTS (SELECT 1 FROM companies c JOIN qualifications q ON q.company_id=c.id WHERE c.run_id=r.id AND q.ai_status='pending')
    )`, [Object.keys(stageQueues)]);
  const runs = await pool.query(`SELECT id FROM discovery_runs WHERE status IN ('queued','running')`);
  for (const run of runs.rows) await reconcileRun(run.id);
}
