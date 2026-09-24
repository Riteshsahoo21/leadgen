import { timingSafeEqual } from 'node:crypto';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import {
  cancelPendingCompanies, closeDatabase, createRun, dashboardOverview, databaseHealth, getRun, listRuns, pool,
  getBusinessDetail, listBusinesses, listMessages, listPipelineEvents, listQualifications,
  logEvent, recentEvents, recentLeads, setRunStatus,
} from './db.js';
import { createRunSchema } from './domain.js';
import { cancelRunJobs, closeQueues, enqueue, queueSnapshot } from './queues.js';

const app = Fastify({ logger: { level: config.NODE_ENV === 'production' ? 'info' : 'debug' } });

await app.register(cors, {
  origin: config.APP_ORIGIN.split(',').map((origin) => origin.trim()),
  methods: ['GET', 'POST', 'DELETE'],
});

app.addHook('onRequest', async (request, reply) => {
  if (!request.url.startsWith('/api/')) return;
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  if (!secureEqual(supplied, config.API_TOKEN)) {
    return reply.code(401).send({ error: 'Unauthorized', message: 'Enter the API token configured on the VPS.' });
  }
});

app.get('/health', async (_request, reply) => {
  try {
    const databaseTime = await databaseHealth();
    return { status: 'ok', databaseTime, mode: config.PROVIDER_MODE };
  } catch (error) {
    return reply.code(503).send({ status: 'unhealthy', error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/config', async () => ({
  providerMode: config.PROVIDER_MODE,
  pipelineStopAfter: config.PIPELINE_STOP_AFTER,
  emailSending: config.ENABLE_EMAIL_SENDING,
  dailySendLimit: config.DAILY_SEND_LIMIT,
  maxDiscoveryResults: config.MAX_DISCOVERY_RESULTS,
  qualificationThreshold: config.MIN_QUALIFICATION_SCORE,
}));

app.get('/api/overview', async () => {
  const [overview, queues, runs, leads, events] = await Promise.all([
    dashboardOverview(), queueSnapshot(), listRuns(8), recentLeads(12), recentEvents(16),
  ]);
  return { overview, queues, runs, leads, events };
});

app.get('/api/runs', async () => ({ runs: await listRuns(50) }));

const listQuerySchema = z.object({
  search: z.string().max(120).optional(),
  status: z.string().max(80).optional(),
  direction: z.enum(['inbound', 'outbound']).optional(),
  qualified: z.enum(['true', 'false']).optional(),
  opportunity: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(250).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

app.get('/api/businesses', async (request, reply) => {
  const parsed = listQuerySchema.safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid query', issues: parsed.error.issues });
  return listBusinesses(parsed.data);
});

app.get<{ Params: { id: string } }>('/api/businesses/:id', async (request, reply) => {
  const business = await getBusinessDetail(request.params.id);
  if (!business) return reply.code(404).send({ error: 'Business not found' });
  return { business };
});

app.post<{ Params: { id: string } }>('/api/businesses/:id/research', async (request, reply) => {
  const result = await pool.query('SELECT id,run_id,website FROM companies WHERE id=$1', [request.params.id]);
  const company = result.rows[0];
  if (!company) return reply.code(404).send({ error: 'Business not found' });
  const queue = company.website ? 'crawl' : 'qualify';
  const status = company.website ? 'crawl_queued' : 'qualify_queued';
  await pool.query('UPDATE companies SET status=$2 WHERE id=$1', [company.id, status]);
  await enqueue(queue, 'refresh-analysis', { runId: company.run_id, companyId: company.id });
  return reply.code(202).send({ status });
});

const backfillSchema = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });

app.post('/api/research/backfill', async (request, reply) => {
  const parsed = backfillSchema.safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid backfill request', issues: parsed.error.issues });
  const result = await pool.query(
    `SELECT c.id,c.run_id FROM companies c
     WHERE NOT EXISTS (SELECT 1 FROM contact_emails e WHERE e.company_id=c.id)
     ORDER BY c.updated_at DESC LIMIT $1`, [parsed.data.limit],
  );
  for (const company of result.rows) {
    await pool.query("UPDATE companies SET status='research_queued' WHERE id=$1", [company.id]);
    await enqueue('research', 'backfill-public-contacts', { runId: company.run_id, companyId: company.id });
  }
  return reply.code(202).send({ queued: result.rowCount ?? 0 });
});

app.post('/api/analysis/backfill', async (request, reply) => {
  const parsed = backfillSchema.safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid analysis backfill request', issues: parsed.error.issues });
  const result = await pool.query(
    `SELECT c.id,c.run_id,c.website FROM companies c
     WHERE c.status NOT IN ('crawl_queued','qualify_queued','research_queued','enrich_queued','campaign_queued')
     ORDER BY c.updated_at DESC LIMIT $1`, [parsed.data.limit],
  );
  for (const company of result.rows) {
    const queue = company.website ? 'crawl' : 'qualify';
    const status = company.website ? 'crawl_queued' : 'qualify_queued';
    await pool.query('UPDATE companies SET status=$2 WHERE id=$1', [company.id, status]);
    await enqueue(queue, 'refresh-analysis', { runId: company.run_id, companyId: company.id });
  }
  return reply.code(202).send({ queued: result.rowCount ?? 0 });
});

app.get('/api/qualifications', async (request, reply) => {
  const parsed = listQuerySchema.safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid query', issues: parsed.error.issues });
  const qualified = parsed.data.qualified === undefined ? undefined : parsed.data.qualified === 'true';
  return { qualifications: await listQualifications({ qualified, opportunity: parsed.data.opportunity, limit: parsed.data.limit }) };
});

app.get('/api/messages', async (request, reply) => {
  const parsed = listQuerySchema.safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid query', issues: parsed.error.issues });
  return { messages: await listMessages({ direction: parsed.data.direction, limit: parsed.data.limit }) };
});

app.get('/api/events', async (request, reply) => {
  const parsed = listQuerySchema.safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid query', issues: parsed.error.issues });
  return { events: await listPipelineEvents(parsed.data.limit) };
});

app.get<{ Params: { id: string } }>('/api/runs/:id', async (request, reply) => {
  const run = await getRun(request.params.id);
  if (!run) return reply.code(404).send({ error: 'Run not found' });
  const companies = await pool.query(
    `SELECT c.*,q.score AS qualification_score,q.opportunity,q.score_breakdown,
       row_number() OVER (ORDER BY q.score DESC NULLS LAST,c.review_count DESC,c.name)::int AS run_rank,
       count(*) OVER ()::int AS run_total,
       CEIL(100.0 * row_number() OVER (ORDER BY q.score DESC NULLS LAST,c.review_count DESC,c.name)
         / GREATEST(count(*) OVER (),1))::int AS top_percent
     FROM companies c LEFT JOIN qualifications q ON q.company_id=c.id
     WHERE c.run_id=$1 ORDER BY q.score DESC NULLS LAST,c.review_count DESC,c.name LIMIT 200`, [run.id],
  );
  return { run, companies: companies.rows };
});

app.post('/api/runs', async (request, reply) => {
  const parsed = createRunSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid discovery request', issues: parsed.error.issues });
  const run = await createRun(parsed.data);
  await enqueue('discovery', 'discover-businesses', { runId: run.id }, `discovery:${run.id}`);
  return reply.code(202).send({ run });
});

app.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (request, reply) => {
  const run = await getRun(request.params.id);
  if (!run) return reply.code(404).send({ error: 'Run not found' });
  if (['completed', 'failed', 'cancelled'].includes(run.status)) {
    return reply.code(409).send({ error: `Run is already ${run.status}` });
  }
  await setRunStatus(run.id, 'cancelled');
  const [removedJobs, cancelledCompanies] = await Promise.all([
    cancelRunJobs(run.id), cancelPendingCompanies(run.id),
  ]);
  await logEvent(run.id, 'cancelled', `Pipeline stopped; removed ${removedJobs} pending jobs and stopped ${cancelledCompanies} companies`);
  return { status: 'cancelled', removedJobs, cancelledCompanies };
});

const inboundSchema = z.object({
  from: z.union([z.string(), z.object({ email: z.string() })]),
  subject: z.string().default(''),
  text: z.string().default(''),
  html: z.string().default(''),
  id: z.string().optional(),
}).passthrough();

app.post('/webhooks/posta', async (request, reply) => {
  if (!secureEqual(String(request.headers['x-webhook-secret'] ?? ''), config.POSTA_WEBHOOK_SECRET)) {
    return reply.code(401).send({ error: 'Invalid webhook secret' });
  }
  const parsed = inboundSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid webhook body' });
  const from = typeof parsed.data.from === 'string' ? parsed.data.from : parsed.data.from.email;
  const address = from.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase();
  if (!address) return reply.code(400).send({ error: 'No sender email found' });
  const emailResult = await pool.query(
    `SELECT e.*,c.run_id FROM contact_emails e JOIN companies c ON c.id=e.company_id WHERE e.email=$1 LIMIT 1`, [address],
  );
  const email = emailResult.rows[0];
  if (!email) return reply.code(202).send({ status: 'ignored', reason: 'unknown sender' });
  const content = `${parsed.data.subject}\n${parsed.data.text || parsed.data.html}`;
  const category = classifyReply(content);
  await pool.query(
    `INSERT INTO messages (run_id,company_id,contact_email_id,direction,status,provider_id,subject,body,reply_category)
     VALUES ($1,$2,$3,'inbound','received',$4,$5,$6,$7)`,
    [email.run_id, email.company_id, email.id, parsed.data.id ?? null, parsed.data.subject, content, category],
  );
  await pool.query('UPDATE companies SET status=$2 WHERE id=$1', [email.company_id, category === 'INTERESTED' ? 'interested' : 'replied']);
  if (['UNSUBSCRIBE', 'NOT_INTERESTED'].includes(category)) {
    await pool.query(
      `INSERT INTO suppression_list (email,reason,source) VALUES ($1,$2,'reply') ON CONFLICT (email) DO NOTHING`,
      [address, category.toLowerCase()],
    );
  }
  return { status: 'accepted', category };
});

function classifyReply(value: string) {
  if (/unsubscribe|remove me|stop emailing|opt.?out/i.test(value)) return 'UNSUBSCRIBE';
  if (/not interested|no thanks|do not contact/i.test(value)) return 'NOT_INTERESTED';
  if (/price|pricing|cost|quote|budget/i.test(value)) return 'PRICING';
  if (/wrong person|not the right person/i.test(value)) return 'WRONG_PERSON';
  if (/interested|let.s talk|book|meeting|sounds good/i.test(value)) return 'INTERESTED';
  if (/\?/.test(value)) return 'QUESTION';
  return 'NEEDS_HUMAN';
}

function secureEqual(left: string, right: string) {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function shutdown(signal: string) {
  app.log.info({ signal }, 'Shutting down');
  await app.close(); await closeQueues(); await closeDatabase();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '0.0.0.0', port: config.API_PORT });
