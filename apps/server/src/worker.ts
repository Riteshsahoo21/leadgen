import { Worker, type Job } from 'bullmq';
import { config } from './config.js';
import {
  closeDatabase, createMessage, eligibleEmail, getCompany, getEvidence, getRun, insertCompany, pool,
  logEvent, markDiscoveryFinished, maybeCompleteRun, refreshRunStats, saveContact, saveEmail,
  saveEvidence, saveQualification, setRunStatus, updateCompanyFilter, updateCompanyStatus,
} from './db.js';
import { calculateFilterScore, type BusinessCandidate, type CreateRunInput } from './domain.js';
import { closeQueues, connection, enqueue } from './queues.js';
import {
  crawlWebsite, discoverBusinesses, enrichEmail, findDecisionMaker, qualifyBusiness, sendWithPosta,
} from './providers.js';

type RunJob = { runId: string };
type CompanyJob = RunJob & { companyId: string };

const workers: Worker[] = [];
const refreshCounters = new Map<string, number>();

function addWorker(name: string, processor: (job: Job) => Promise<unknown>, concurrency: number, limiter?: { max: number; duration: number }) {
  const worker = new Worker(name, processor, { connection, concurrency, ...(limiter ? { limiter } : {}) });
  worker.on('completed', (job) => console.log(`[${name}] completed ${job.id}`));
  worker.on('failed', async (job, error) => {
    console.error(`[${name}] failed ${job?.id}:`, error.message);
    const data = job?.data as Partial<CompanyJob> | undefined;
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1) && data?.companyId && data.runId) {
      await updateCompanyStatus(data.companyId, 'failed').catch(() => undefined);
      await logEvent(data.runId, name, error.message, data.companyId).catch(() => undefined);
      await maybeCompleteRun(data.runId).catch(() => undefined);
    }
  });
  workers.push(worker);
}

addWorker('discovery', async (job: Job<RunJob>) => {
  const run = await getRun(job.data.runId);
  if (!run || run.status === 'cancelled') return;
  await setRunStatus(run.id, 'running');
  await logEvent(run.id, 'discovery', `Building queries for ${run.business_types.length} business types across ${run.cities.length} cities`);
  const input: CreateRunInput = {
    name: run.name, country: run.country, cities: run.cities, businessTypes: run.business_types,
    targetCount: Math.min(run.target_count, config.MAX_DISCOVERY_RESULTS),
  };
  try {
    const businesses = await discoverBusinesses(input);
    for (const business of businesses) {
      business.country ||= input.country;
      const company = await insertCompany(run.id, business);
      await enqueue('filter', 'filter-company', { runId: run.id, companyId: company.id }, `filter:${company.id}`);
    }
    await markDiscoveryFinished(run.id);
    await refreshRunStats(run.id);
    await logEvent(run.id, 'discovery', `Discovery finished with ${businesses.length} unique candidates`);
    await maybeCompleteRun(run.id);
    return { discovered: businesses.length };
  } catch (error) {
    await setRunStatus(run.id, 'failed', error instanceof Error ? error.message : String(error));
    throw error;
  }
}, config.DISCOVERY_CONCURRENCY);

addWorker('filter', async (job: Job<CompanyJob>) => {
  const company = await getCompany(job.data.companyId) as BusinessCandidate & { id: string; run_id: string; review_count: number };
  if (!company) return;
  const candidate = fromCompany(company);
  const result = calculateFilterScore(candidate);
  if (result.score < config.MIN_FILTER_SCORE) {
    await updateCompanyFilter(company.id, result.score, result.reasons, 'filtered_out');
    await finishOne(company.run_id);
    return;
  }
  const nextStatus = company.website ? 'crawl_queued' : 'qualify_queued';
  await updateCompanyFilter(company.id, result.score, result.reasons, nextStatus);
  await enqueue(company.website ? 'crawl' : 'qualify', company.website ? 'crawl-company' : 'qualify-company',
    job.data, `${company.website ? 'crawl' : 'qualify'}:${company.id}`);
}, 6);

addWorker('crawl', async (job: Job<CompanyJob>) => {
  const company = await getCompany(job.data.companyId);
  if (!company) return;
  try {
    const evidence = await crawlWebsite(fromCompany(company));
    await saveEvidence(company.id, evidence);
    await updateCompanyStatus(company.id, 'qualify_queued');
    await enqueue('qualify', 'qualify-company', job.data, `qualify:${company.id}`);
  } catch (error) {
    await saveEvidence(company.id, { pagesCrawled: 0, crawlError: error instanceof Error ? error.message : String(error) });
    await updateCompanyStatus(company.id, 'qualify_queued');
    await enqueue('qualify', 'qualify-company', job.data, `qualify:${company.id}`);
  }
}, config.CRAWL_CONCURRENCY);

addWorker('qualify', async (job: Job<CompanyJob>) => {
  const company = await getCompany(job.data.companyId);
  if (!company) return;
  const evidence = await getEvidence(company.id);
  const qualification = await qualifyBusiness(fromCompany(company), evidence);
  await saveQualification(company.id, qualification);
  if (!qualification.qualified) {
    await updateCompanyStatus(company.id, 'unqualified');
    await finishOne(company.run_id);
    return;
  }
  await updateCompanyStatus(company.id, 'research_queued');
  await enqueue('research', 'find-decision-maker', job.data, `research:${company.id}`);
  await maybeRefresh(company.run_id);
}, config.AI_CONCURRENCY);

addWorker('research', async (job: Job<CompanyJob>) => {
  const company = await getCompany(job.data.companyId);
  if (!company) return;
  const contact = await findDecisionMaker(fromCompany(company));
  if (!contact) {
    await updateCompanyStatus(company.id, 'no_contact');
    await finishOne(company.run_id);
    return;
  }
  const saved = await saveContact(company.id, contact);
  await updateCompanyStatus(company.id, 'enrich_queued');
  await enqueue('enrich', 'enrich-email', { ...job.data, contactId: saved.id }, `enrich:${company.id}:${saved.id}`);
  await maybeRefresh(company.run_id);
}, config.SEARCH_CONCURRENCY);

addWorker('enrich', async (job: Job<CompanyJob & { contactId: string }>) => {
  const company = await getCompany(job.data.companyId);
  if (!company) return;
  const evidence = await getEvidence(company.id);
  const contactResult = await pool.query('SELECT * FROM contacts WHERE id=$1', [job.data.contactId]);
  const contact = contactResult.rows[0];
  if (!contact) return;
  const result = await enrichEmail(fromCompany(company), contact.full_name, evidence?.emails ?? []);
  if (!result) {
    await updateCompanyStatus(company.id, 'no_email');
    await finishOne(company.run_id);
    return;
  }
  const email = await saveEmail(contact.id, company.id, result);
  if (result.status !== 'valid') {
    await updateCompanyStatus(company.id, result.status === 'invalid' ? 'invalid_email' : 'email_risky');
    await finishOne(company.run_id);
    return;
  }
  await updateCompanyStatus(company.id, 'campaign_queued');
  await enqueue('campaign', 'prepare-message', { ...job.data, emailId: email.id }, `campaign:${email.id}`);
  await maybeRefresh(company.run_id);
}, config.ENRICHMENT_CONCURRENCY);

addWorker('campaign', async (job: Job<CompanyJob & { emailId: string }>) => {
  const lead = await eligibleEmail(job.data.emailId);
  if (!lead) return;
  const firstName = String(lead.full_name).split(' ')[0];
  const subject = `A quick idea for ${lead.company_name}`;
  const painPoint = Array.isArray(lead.pain_points) ? lead.pain_points[0] : undefined;
  const body = `Hi ${firstName},\n\nI came across ${lead.company_name} and noticed ${painPoint ?? 'an opportunity to improve the customer journey'}. Would a short, no-pressure review be useful?\n\nIf this is not relevant, reply unsubscribe and I will not contact you again.`;
  if (config.PROVIDER_MODE === 'live' && config.ENABLE_EMAIL_SENDING) {
    const sent = await sendWithPosta(lead.email, subject, body);
    await createMessage({ runId: lead.run_id, companyId: lead.company_id, emailId: lead.id, status: 'sent', providerId: sent.id, subject, body });
    await updateCompanyStatus(lead.company_id, 'contacted');
    await logEvent(lead.run_id, 'campaign', `Message sent to ${lead.email}`, lead.company_id);
  } else {
    await createMessage({ runId: lead.run_id, companyId: lead.company_id, emailId: lead.id, status: 'draft', subject, body });
    await updateCompanyStatus(lead.company_id, 'drafted');
  }
  await finishOne(lead.run_id);
}, config.CAMPAIGN_CONCURRENCY,
  config.ENABLE_EMAIL_SENDING ? { max: config.DAILY_SEND_LIMIT, duration: 86_400_000 } : undefined);

function fromCompany(company: Record<string, any>): BusinessCandidate {
  return {
    sourceId: company.source_id, name: company.name, category: company.category,
    categories: company.categories, country: company.country, city: company.city,
    address: company.address, phone: company.phone, website: company.website,
    rating: company.rating == null ? undefined : Number(company.rating), reviewCount: company.review_count,
    latitude: company.latitude, longitude: company.longitude, raw: company.raw_data,
  };
}

async function maybeRefresh(runId: string) {
  const next = (refreshCounters.get(runId) ?? 0) + 1;
  refreshCounters.set(runId, next);
  if (next % 25 === 0) await refreshRunStats(runId);
}

async function finishOne(runId: string) {
  await maybeRefresh(runId);
  await maybeCompleteRun(runId);
}

async function shutdown(signal: string) {
  console.log(`Received ${signal}; closing workers`);
  await Promise.all(workers.map((worker) => worker.close()));
  await closeQueues();
  await closeDatabase();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
console.log(`LeadForge workers started in ${config.PROVIDER_MODE} mode`);
