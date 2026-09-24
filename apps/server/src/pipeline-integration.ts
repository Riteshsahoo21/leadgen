// Explicit, isolated smoke/load test. Never creates leads in the production DB.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import Redis from 'ioredis';

assert.equal(process.env.RUN_PIPELINE_INTEGRATION, '1', 'Explicit test opt-in required');
const originalUrl = process.env.DATABASE_URL!;
const admin = new pg.Pool({ connectionString: originalUrl, max: 1 });
const database = `leadforge_test_${Date.now()}`;
assert.match(database, /^leadforge_test_[0-9]+$/);
const redisUrl = new URL(process.env.REDIS_URL!);
redisUrl.pathname = '/15';
const probe = new Redis.default(redisUrl.toString());
assert.equal(await probe.dbsize(), 0, 'Redis DB 15 must be empty; refusing to touch existing data');
await probe.quit();
await admin.query(`CREATE DATABASE ${database}`);
const testUrl = new URL(originalUrl);
testUrl.pathname = `/${database}`;
process.env.DATABASE_URL = testUrl.toString();
process.env.REDIS_URL = redisUrl.toString();
process.env.PROVIDER_MODE = 'safe';
process.env.ENABLE_EMAIL_SENDING = 'false';
process.env.API_PORT = '3099';
process.env.MIN_QUALIFICATION_SCORE = '60';
process.env.MAX_DISCOVERY_RESULTS = '5000';
let worker: ChildProcess | undefined;
let apiProcess: ChildProcess | undefined;
const db = await import('./db.js');
const queues = await import('./queues.js');
const start = Date.now();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`http://127.0.0.1:3099${path}`, {
    method, headers: { authorization: `Bearer ${process.env.API_TOKEN}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json() as any };
}
async function until(check: () => Promise<boolean>, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for pipeline progress');
    await sleep(1_000);
  }
}
function child(file: string) {
  const process = spawn(globalThis.process.execPath, [`apps/server/dist/${file}.js`], { stdio: ['ignore', 'ignore', 'pipe'] });
  process.stderr?.on('data', chunk => globalThis.process.stderr.write(chunk));
  return process;
}
try {
  for (const file of (await readdir('/app/database')).filter(name => name.endsWith('.sql')).sort()) {
    await db.pool.query(await readFile(`/app/database/${file}`, 'utf8'));
  }
  apiProcess = child('api');
  await until(async () => { try { return (await request('/health')).status === 200; } catch { return false; } });
  const created = await request('/api/runs', 'POST', {
    name: 'ISOLATED 3000 pipeline test', country: 'India', cities: ['Test City'], businessTypes: ['dentist'], targetCount: 3000,
  });
  assert.equal(created.status, 202);
  const id = created.data.run.id;
  assert.equal((await request(`/api/runs/${id}/pause`, 'POST')).status, 200);
  worker = child('worker');
  await until(async () => (await queues.queues.discovery.getDelayedCount()) > 0);
  assert.equal((await db.getRun(id)).status, 'paused');
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM companies')).rows[0].n, 0);
  const pausedJob = (await queues.queues.discovery.getJobs(['delayed']))[0]!;
  assert.equal(pausedJob.attemptsMade, 0, 'Pausing must not consume retries');
  assert.equal((await request(`/api/runs/${id}/resume`, 'POST')).status, 200);
  assert.equal((await request(`/api/runs/${id}/resume`, 'POST')).status, 409);
  await pausedJob.promote();
  await until(async () => Number((await db.pool.query('SELECT count(*) AS n FROM companies WHERE run_id=$1', [id])).rows[0].n) >= 100);
  assert.equal((await request(`/api/runs/${id}/pause`, 'POST')).status, 200);
  await sleep(1_000);
  assert.equal((await db.getRun(id)).status, 'paused');
  assert.equal((await request(`/api/runs/${id}/resume`, 'POST')).status, 200);
  await until(async () => (await db.getRun(id)).status === 'completed', 300_000);
  const run = await db.getRun(id);
  assert.equal(run.stats.discovered, 3000);
  assert.equal(run.stats.pending, 0);
  assert.equal(run.stats.ai_pending, 0);
  assert.equal(run.discovery_state.reason, 'target_reached');
  assert.ok(run.stats.evaluated > 250);
  assert.equal(run.stats.finished, 3000);
  const page1 = await request('/api/qualifications?limit=100&offset=0');
  const page2 = await request('/api/qualifications?limit=100&offset=100');
  assert.equal(page1.status, 200);
  assert.equal(page2.data.qualifications.length, 100);
  assert.equal(new Set([...page1.data.qualifications, ...page2.data.qualifications].map(row => row.id)).size, 200);
  assert.equal((await request(`/api/runs/${id}?limit=100&offset=2900`)).data.companies.length, 100);
  assert.equal((await request('/api/overview')).data.overview.businesses, 3000);
  console.log(JSON.stringify({ test: '3000 businesses, active pause/resume, dedupe, pagination, synchronized completion', stats: run.stats, seconds: Math.round((Date.now() - start) / 1000) }));

  const stopped = await request('/api/runs', 'POST', {
    name: 'ISOLATED stop test', country: 'India', cities: ['Stop City'], businessTypes: ['clinic'], targetCount: 3000,
  });
  const stopId = stopped.data.run.id;
  assert.equal((await request(`/api/runs/${stopId}/cancel`, 'POST')).status, 200);
  assert.equal((await request(`/api/runs/${stopId}/resume`, 'POST')).status, 409);
  await db.setRunStatus(stopId, 'running');
  assert.equal((await db.getRun(stopId)).status, 'cancelled');
  await sleep(2_000);
  assert.equal((await db.getRun(stopId)).status, 'cancelled');
  console.log('PASS: permanent stop cannot be overwritten or resumed');

  // Recover an orphaned DB stage without an associated Redis job.
  const recovered = await db.createRun({ name: 'ISOLATED recovery test', country: 'India', cities: ['Recovery'], businessTypes: ['dentist'], targetCount: 1 });
  await db.setRunStatus(recovered.id, 'running');
  await db.insertCompany(recovered.id, { name: 'Recovery Dental', country: 'India', phone: '+919999999999', reviewCount: 200, rating: 4.8 });
  await db.markDiscoveryFinished(recovered.id);
  await until(async () => (await db.getRun(recovered.id)).status === 'completed', 60_000);
  assert.equal((await db.getRun(recovered.id)).stats.discovered, 1);
  console.log('PASS: orphan-stage recovery from PostgreSQL');
} finally {
  worker?.kill('SIGKILL'); apiProcess?.kill('SIGKILL');
  await sleep(1_000);
  // Only these dedicated test queues in the verified-empty DB 15 are removed.
  for (const queue of Object.values(queues.queues)) await queue.obliterate({ force: true });
  await queues.closeQueues();
  await db.closeDatabase();
  await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
  await admin.end();
  console.log('Isolated test database and queues cleaned up; production data untouched.');
}
