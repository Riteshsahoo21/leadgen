import { DelayedError, Worker, type Job } from 'bullmq';
import { config } from './config.js';
import { RunPausedError } from './run-control.js';
import { reconcileActiveRuns, stageQueues } from './reconcile.js';
import {
  closeDatabase, createMessage, eligibleEmail, getCompany, getEvidence, getRun, insertCompany, isRunCancelled, pool,
  logEvent, markDiscoveryFinished, maybeCompleteRun, refreshRunStats, saveContact, saveEmail,
  saveEvidence, saveQualificationWithinQuota, setRunStatus, updateCompanyFilter, updateCompanyStatus, mergePublicContactEvidence,
} from './db.js';
import { calculateFilterScore, normalizeDomain, type BusinessCandidate, type CreateRunInput } from './domain.js';
import { closeQueues, connection, enqueue } from './queues.js';
import {
  buildDiscoveryKeywords, buildNoWebsiteKeywords, crawlWebsite, discoverBusinesses, enrichEmails, findDecisionMakers, parseOwner, parseStringList,
  qualifyBusiness, researchPublicContacts, sendWithPosta,
} from './providers.js';

type RunJob = { runId: string };
type CompanyJob = RunJob & { companyId: string };

const workers: Worker[] = [];
const refreshCounters = new Map<string, { count: number; refreshedAt: number }>();

function addWorker(name: string, processor: (job: Job) => Promise<unknown>, concurrency: number, limiter?: { max: number; duration: number }) {
  const guardedProcessor = async (job: Job, token?: string) => {
    try {
      const data = job.data as Partial<CompanyJob> | undefined;
      if (data?.runId && await isRunCancelled(data.runId)) return { cancelled: true };
      if (data?.companyId) {
        const company = await getCompany(data.companyId);
        if (!company) return;
        if (name !== 'ai' && stageQueues[company.status] !== name) return { superseded: true };
        if (name === 'ai') {
          const row = await pool.query("SELECT ai_status FROM qualifications WHERE company_id=$1", [company.id]);
          if (row.rows[0]?.ai_status !== 'pending') return { superseded: true };
        }
      }
      return await processor(job);
    } catch (error) {
      if (!(error instanceof RunPausedError)) throw error;
      // Delayed jobs retain their ID and checkpoint and do not consume retries.
      await job.moveToDelayed(Date.now() + 30_000, token);
      throw new DelayedError();
    }
  };
  const worker = new Worker(name, guardedProcessor, { connection, concurrency, ...(limiter ? { limiter } : {}) });
  worker.on('completed', (job) => console.log(`[${name}] completed ${job.id}`));
  worker.on('failed', async (job, error) => {
    console.error(`[${name}] failed ${job?.id}:`, error.message);
    const data = job?.data as Partial<CompanyJob> | undefined;
    if (name === 'discovery' && job && job.attemptsMade >= (job.opts.attempts ?? 1) && data?.runId) {
      const run = await getRun(data.runId).catch(() => undefined);
      if (run && !['paused','cancelled'].includes(run.status)) {
        await setRunStatus(data.runId, 'failed', error.message).catch(() => undefined);
        await logEvent(data.runId, 'discovery', error.message).catch(() => undefined);
      }
    }
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1) && data?.companyId && data.runId) {
      const run = await getRun(data.runId).catch(() => undefined);
      if (!run || run.status === 'cancelled') return;
      if (name === 'ai') {
        await pool.query("UPDATE qualifications SET ai_status='fallback' WHERE company_id=$1", [data.companyId]).catch(() => undefined);
      } else {
        await updateCompanyStatus(data.companyId, 'failed').catch(() => undefined);
      }
      await logEvent(data.runId, name, error.message, data.companyId).catch(() => undefined);
      await maybeCompleteRun(data.runId).catch(() => undefined);
    }
  });
  workers.push(worker);
}

addWorker('discovery', async (job: Job<RunJob>) => {
  const run = await getRun(job.data.runId);
  if (!run || run.discovery_finished_at || await isRunCancelled(run.id)) return;
  await pool.query("UPDATE discovery_runs SET status='running',started_at=COALESCE(started_at,now()),completed_at=NULL WHERE id=$1 AND status='queued'", [run.id]);
  const input: CreateRunInput = {
    name: run.name, country: run.country, cities: run.cities, businessTypes: run.business_types,
    targetCount: Number(run.target_count), maxDiscovery: Number(run.max_discovery || run.target_count * 2),
  };

  const noWebsiteTarget = Math.ceil(input.targetCount * 0.6);
  const incompleteTarget = input.targetCount - noWebsiteTarget;

  const state = run.discovery_state ?? {};
  let phase: 'no_website' | 'website_improvement' = state.phase ?? 'no_website';
  let keywords: string[] = state.keywords ?? (phase === 'no_website' ? buildNoWebsiteKeywords(input) : buildDiscoveryKeywords(input));
  let cursor = Number(state.cursor ?? 0);
  let jobId: string | undefined = state.jobId;

  const saveState = async (reason?: string) => {
    await pool.query('UPDATE discovery_runs SET discovery_state=$2 WHERE id=$1',
      [run.id, { keywords, cursor, jobId, phase, ...(reason ? { reason } : {}) }]);
  };

  let count = Number((await pool.query('SELECT count(*) FROM companies WHERE run_id=$1', [run.id])).rows[0].count);

  const getOpportunityCounts = async () => {
    const res = await pool.query<{ no_website: string; incomplete: string }>(
      `SELECT
         count(*) FILTER (WHERE q.qualified AND q.opportunity='new_website') AS no_website,
         count(*) FILTER (WHERE q.qualified AND q.opportunity='website_improvement') AS incomplete
       FROM qualifications q JOIN companies c ON c.id=q.company_id WHERE c.run_id=$1`,
      [run.id]
    );
    return {
      noWebsite: Number(res.rows[0]?.no_website ?? 0),
      incomplete: Number(res.rows[0]?.incomplete ?? 0),
    };
  };

  while (true) {
    if (await isRunCancelled(run.id)) return;
    const oppCounts = await getOpportunityCounts();
    const qualifiedCount = oppCounts.noWebsite + oppCounts.incomplete;

    if (qualifiedCount >= input.targetCount) break;

    if (phase === 'no_website') {
      if (oppCounts.noWebsite >= noWebsiteTarget || cursor >= keywords.length) {
        await logEvent(run.id, 'discovery',
          `Phase 1 completed: ${oppCounts.noWebsite}/${noWebsiteTarget} businesses without a website found. Transitioning to Phase 2: Websites Needing Improvement.`);

        if (oppCounts.incomplete >= incompleteTarget) {
          await logEvent(run.id, 'discovery',
            `Target quota reached (${oppCounts.noWebsite} without website, ${oppCounts.incomplete} website improvements). Discovery finished.`);
          break;
        }

        // Unfreeze deferred companies with websites collected during Phase 1
        const deferred = await pool.query<{ id: string }>(
          "SELECT id FROM companies WHERE run_id=$1 AND status='deferred_has_website'", [run.id]
        );
        for (const row of deferred.rows) {
          await pool.query("UPDATE companies SET status='discovered' WHERE id=$1", [row.id]);
          await enqueue('filter', 'filter-company', { runId: run.id, companyId: row.id }, `filter:${row.id}`);
        }
        if (deferred.rows.length > 0) {
          await logEvent(run.id, 'discovery',
            `Activated ${deferred.rows.length} businesses with websites collected during Phase 1 for crawling and qualification.`);
        }

        phase = 'website_improvement';
        keywords = buildDiscoveryKeywords(input);
        cursor = 0;
        jobId = undefined;
        await saveState();
        await refreshRunStats(run.id);
        continue;
      }
    } else {
      if (oppCounts.incomplete >= incompleteTarget || cursor >= keywords.length) {
        break;
      }
    }

    const searchKeywords = keywords.slice(cursor, cursor + 4);
    if (!searchKeywords.length) break;

    const phaseLabel = phase === 'no_website' ? 'Phase 1: No-Website' : 'Phase 2: Website Improvement';
    const phaseProgress = phase === 'no_website' ? `${oppCounts.noWebsite}/${noWebsiteTarget}` : `${oppCounts.incomplete}/${incompleteTarget}`;
    await logEvent(run.id, 'discovery',
      `[${phaseLabel}] Batch ${cursor + 1}-${cursor + searchKeywords.length}/${keywords.length}; ${phaseProgress} qualified (${count} scraped)`);

    try {
      const businesses = await discoverBusinesses(
        { ...input, maxDiscovery: Math.max(40, Math.min(120, Math.ceil((input.targetCount - qualifiedCount) * 2))) },
        () => isRunCancelled(run.id),
        {
          keywords: searchKeywords,
          phase,
          ...(jobId ? { jobId } : {}),
          saveJob: async (id) => { jobId = id; await saveState(); },
          onProgress: async (msg) => { await logEvent(run.id, 'discovery', msg); },
        },
      );
      if (await isRunCancelled(run.id)) return;

      for (const business of businesses) {
        if (await isRunCancelled(run.id)) break;
        business.country ||= input.country;
        const hasWebsite = Boolean(business.website && business.website.trim());

        if (phase === 'no_website') {
          if (!hasWebsite) {
            const currentOpp = await getOpportunityCounts();
            if (currentOpp.noWebsite < noWebsiteTarget) {
              const company = await insertCompany(run.id, business, 'discovered');
              if (company.status === 'discovered') {
                await enqueue('filter', 'filter-company', { runId: run.id, companyId: company.id }, `filter:${company.id}`);
              }
            }
          } else {
            // Interleaved: If under the 40% cap, crawl & qualify immediately!
            const currentOpp = await getOpportunityCounts();
            if (currentOpp.incomplete < incompleteTarget) {
              const company = await insertCompany(run.id, business, 'discovered');
              if (company.status === 'discovered') {
                await enqueue('filter', 'filter-company', { runId: run.id, companyId: company.id }, `filter:${company.id}`);
              }
            } else {
              await insertCompany(run.id, business, 'deferred_has_website');
            }
          }
        } else {
          const currentOpp = await getOpportunityCounts();
          if (currentOpp.incomplete < incompleteTarget) {
            const company = await insertCompany(run.id, business, 'discovered');
            if (company.status === 'discovered') {
              await enqueue('filter', 'filter-company', { runId: run.id, companyId: company.id }, `filter:${company.id}`);
            }
          }
        }
        await maybeRefresh(run.id);
      }
      count = Number((await pool.query('SELECT count(*) FROM companies WHERE run_id=$1', [run.id])).rows[0].count);
    } catch (batchError) {
      if (batchError instanceof RunPausedError) throw batchError;
      if (await isRunCancelled(run.id)) return;
      console.warn(`[discovery] Search batch ${cursor + 1} error:`, batchError instanceof Error ? batchError.message : String(batchError));
      await logEvent(run.id, 'discovery', `Search batch ${cursor + 1} skipped due to issue: ${batchError instanceof Error ? batchError.message : String(batchError)}`);
    }

    if (await isRunCancelled(run.id)) return;
    cursor += searchKeywords.length;
    jobId = undefined;
    await saveState();
    await refreshRunStats(run.id);
  }

  if (await isRunCancelled(run.id)) return;

  // Wait briefly for in-flight qualifications to finish
  let inFlight = Number((await pool.query(
    `SELECT count(*) FROM companies WHERE run_id=$1 AND status IN ('discovered', 'crawl_queued', 'crawling', 'qualify_queued', 'qualifying')`,
    [run.id]
  )).rows[0].count);
  let waitRounds = 0;
  while (inFlight > 0 && waitRounds < 15) {
    if (await isRunCancelled(run.id)) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    inFlight = Number((await pool.query(
      `SELECT count(*) FROM companies WHERE run_id=$1 AND status IN ('discovered', 'crawl_queued', 'crawling', 'qualify_queued', 'qualifying')`,
      [run.id]
    )).rows[0].count);
    waitRounds += 1;
  }

  const finalCounts = await getOpportunityCounts();
  const totalQualified = finalCounts.noWebsite + finalCounts.incomplete;
  const reason = totalQualified >= input.targetCount ? 'target_reached' : 'search_plan_exhausted';
  await saveState(reason);
  await markDiscoveryFinished(run.id);
  await refreshRunStats(run.id);
  await logEvent(run.id, 'discovery', reason === 'target_reached'
    ? `Discovery target reached: ${totalQualified}/${input.targetCount} qualified leads (${finalCounts.noWebsite} without website, ${finalCounts.incomplete} needing website improvement). Remaining stages are processing.`
    : `Search plan completed: ${totalQualified}/${input.targetCount} qualified leads (${finalCounts.noWebsite} without website, ${finalCounts.incomplete} needing website improvement).`);
  await maybeCompleteRun(run.id);
  return { discovered: count, qualified: totalQualified, reason };
}, 1);

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
    console.log(`[worker:crawl] Crawlee crawling ${company.website} for "${company.name}" (ID: ${company.id})...`);
    const evidence = await crawlWebsite(fromCompany(company));
    if (await isRunCancelled(company.run_id)) return { cancelled: true };
    await saveEvidence(company.id, evidence);
    await logEvent(
      company.run_id,
      'crawl',
      `Crawlee crawled ${evidence.pagesCrawled} page${evidence.pagesCrawled === 1 ? '' : 's'} (${evidence.emails.length} emails, ${evidence.phones.length} phones)${evidence.usedBrowser ? ' [rendered with Playwright]' : ''}`,
      company.id,
      { pagesCrawled: evidence.pagesCrawled, emailsFound: evidence.emails.length, usedBrowser: evidence.usedBrowser }
    );
    await updateCompanyStatus(company.id, 'qualify_queued');
    await enqueue('qualify', 'qualify-company', job.data, `qualify:${company.id}`);
    await maybeRefresh(company.run_id);
  } catch (error) {
    if (await isRunCancelled(company.run_id)) return { cancelled: true };
    const errMsg = error instanceof Error ? error.message : String(error);
    console.warn(`[worker:crawl] Crawlee crawl failed for "${company.name}" (${company.website}): ${errMsg}`);
    await saveEvidence(company.id, { pagesCrawled: 0, crawlError: errMsg });
    await logEvent(
      company.run_id,
      'crawl',
      `Crawlee crawl failed for ${company.website}: ${errMsg}`,
      company.id,
      { error: errMsg }
    );
    await updateCompanyStatus(company.id, 'qualify_queued');
    await enqueue('qualify', 'qualify-company', job.data, `qualify:${company.id}`);
    await maybeRefresh(company.run_id);
  }
}, config.CRAWL_CONCURRENCY);

addWorker('qualify', async (job: Job<CompanyJob>) => {
  const company = await getCompany(job.data.companyId);
  if (!company) return;
  const evidence = await getEvidence(company.id);
  const qualification = await qualifyBusiness(fromCompany(company), evidence, false);
  if (await isRunCancelled(company.run_id)) return { cancelled: true };

  const aiEnabled = config.ENABLE_AI && config.PROVIDER_MODE === 'live';
  const savedQualification = await saveQualificationWithinQuota(company.id, company.run_id, {
    ...qualification,
    aiStatus: qualification.qualified && company.website && aiEnabled ? 'pending' : 'not_requested',
  });
  if (!savedQualification.qualified) {
    await updateCompanyStatus(company.id, 'unqualified');
    await finishOne(company.run_id);
    return;
  }
  if (company.website && aiEnabled) {
    await enqueue('ai', 'explain-qualification', job.data, `ai:${company.id}`);
  }
  await updateCompanyStatus(company.id, 'research_queued');
  await enqueue('research', 'find-decision-maker', job.data, `research:${company.id}`);
  await maybeRefresh(company.run_id);
}, 6);

addWorker('ai', async (job: Job<CompanyJob>) => {
  if (!config.ENABLE_AI) return;
  const company = await getCompany(job.data.companyId);
  if (!company) return;
  const evidence = await getEvidence(company.id);
  const qualification = await qualifyBusiness(fromCompany(company), evidence, true);
  if (await isRunCancelled(company.run_id)) return { cancelled: true };
  // AI may explain the assessment, never silently change the routing/score
  // after contact research has already begun.
  await pool.query(`UPDATE qualifications SET rationale=$2,model=$3,ai_status=$4
    WHERE company_id=$1 AND ai_status='pending'`, [
    company.id, qualification.rationale, qualification.model,
    qualification.model === config.OLLAMA_MODEL ? 'completed' : 'fallback',
  ]);
  await finishOne(company.run_id);
}, config.AI_CONCURRENCY);

addWorker('research', async (job: Job<CompanyJob>) => {
  const company = await getCompany(job.data.companyId);
  if (!company) return;
  const candidate = fromCompany(company);
  let evidence = await getEvidence(company.id);
  if (company.website && ['refresh-public-contacts', 'backfill-public-contacts'].includes(job.name)) {
    try {
      await saveEvidence(company.id, await crawlWebsite(candidate));
      evidence = await getEvidence(company.id);
    } catch (error) {
      await logEvent(company.run_id, 'research', `Contact refresh crawl failed: ${error instanceof Error ? error.message : String(error)}`, company.id);
    }
  }
  const publicResearch = await researchPublicContacts(candidate, evidence);
  if (await isRunCancelled(company.run_id)) return { cancelled: true };
  await mergePublicContactEvidence(company.id, publicResearch);

  // If the company lacked a website on Google Maps, check if research discovered their official website or domain
  if (!company.website) {
    let discoveredWebsite = publicResearch.searchResults.find((r) => {
      if (!r.url) return false;
      const d = normalizeDomain(r.url);
      if (!d || /(?:facebook|linkedin|instagram|twitter|x\.com|youtube|yellowpages|cylex|ezyfind|snupit|google|bing|yahoo|africabizinfo|biz)\b/i.test(d)) return false;
      const tokens = company.name.toLowerCase().split(/[^a-z0-9]+/).filter((t: string) => t.length >= 3 && !['pty','ltd','the','and','for'].includes(t));
      return tokens.some((t: string) => d.includes(t));
    })?.url;



    if (discoveredWebsite) {
      const normDomain = normalizeDomain(discoveredWebsite);
      company.website = discoveredWebsite;
      candidate.website = discoveredWebsite;
      let domainClaimed = false;
      if (normDomain) {
        const existing = await pool.query('SELECT id FROM companies WHERE run_id=$1 AND domain=$2 AND id<>$3 LIMIT 1', [company.run_id, normDomain, company.id]);
        if (existing.rows.length > 0) domainClaimed = true;
      }
      if (normDomain && !domainClaimed) {
        company.domain = normDomain;
        await pool.query('UPDATE companies SET website=$2, domain=$3 WHERE id=$1', [company.id, discoveredWebsite, normDomain]);
      } else {
        await pool.query('UPDATE companies SET website=$2 WHERE id=$1', [company.id, discoveredWebsite]);
      }
      await logEvent(company.run_id, 'research', `Discovered official website for ${company.name}: ${discoveredWebsite}`, company.id);
      try {
        await saveEvidence(company.id, await crawlWebsite(candidate));
      } catch (error) {
        await saveEvidence(company.id, { pagesCrawled: 0, crawlError: error instanceof Error ? error.message : String(error) });
      }
      evidence = await getEvidence(company.id);
      const revised = await qualifyBusiness(candidate, evidence, false);
      const saved = await saveQualificationWithinQuota(company.id, company.run_id, { ...revised, aiStatus: 'not_requested' });
      if (!saved.qualified) {
        await updateCompanyStatus(company.id, 'unqualified');
        await finishOne(company.run_id);
        return;
      }
    }
  }

  const contacts = await findDecisionMakers(candidate, 'Owner', publicResearch.searchResults);
  if (!contacts.length && publicResearch.emails.length) {
    const emailSource = publicResearch.sources.find((source) => source.kind === 'email');
    contacts.push({
      fullName: company.name, role: 'Business contact',
      confidence: emailSource?.sourceType === 'company_website' || emailSource?.sourceType === 'google_maps' ? 82 : 68,
      ...(emailSource?.sourceUrl ? { sourceUrl: emailSource.sourceUrl } : {}),
    });
  }
  if (!contacts.length && (company.domain || company.website || candidate.publicEmails?.length)) {
    contacts.push({
      fullName: company.name,
      role: 'General Enquiries',
      confidence: 60,
      ...(candidate.website ? { sourceUrl: candidate.website } : {}),
    });
  }
  if (!contacts.length) {
    await updateCompanyStatus(company.id, 'no_contact');
    await finishOne(company.run_id);
    return;
  }
  const savedContacts = await Promise.all(contacts.map((contact) => saveContact(company.id, contact)));
  const saved = savedContacts[0]!;
  if (config.PIPELINE_STOP_AFTER === 'research') {
    await updateCompanyStatus(company.id, 'contact_found');
    await finishOne(company.run_id);
    return;
  }
  await updateCompanyStatus(company.id, 'enrich_queued');
  await enqueue('enrich', 'enrich-email', { ...job.data, contactId: saved.id }, `enrich:${company.id}`);
  await maybeRefresh(company.run_id);
}, config.SEARCH_CONCURRENCY);

addWorker('enrich', async (job: Job<CompanyJob & { contactId: string }>) => {
  const company = await getCompany(job.data.companyId);
  if (!company) return;
  const evidence = await getEvidence(company.id);
  const contactResult = await pool.query('SELECT * FROM contacts WHERE id=$1', [job.data.contactId]);
  const contact = contactResult.rows[0];
  if (!contact) throw new Error('Enrichment contact is missing; retry research for this business');
  const sources = Array.isArray(evidence?.contact_sources) ? evidence.contact_sources : [];
  const results = await enrichEmails(fromCompany(company), contact.full_name, sources, evidence?.emails ?? []);
  if (await isRunCancelled(company.run_id)) return { cancelled: true };
  if (!results.length) {
    await updateCompanyStatus(company.id, 'no_email');
    await finishOne(company.run_id);
    return;
  }
  const savedEmails = await Promise.all(results.map((result) => saveEmail(contact.id, company.id, result)));
  const validIndex = results.findIndex((result) => result.status === 'valid');
  if (validIndex < 0) {
    await updateCompanyStatus(company.id, results.some((result) => result.status === 'risky') ? 'email_risky' : 'invalid_email');
    await finishOne(company.run_id);
    return;
  }
  if (config.PIPELINE_STOP_AFTER === 'enrichment') {
    await updateCompanyStatus(company.id, 'email_verified');
    await finishOne(company.run_id);
    return;
  }
  await updateCompanyStatus(company.id, 'campaign_queued');
  const campaignEmail = savedEmails[validIndex]!;
  await enqueue('campaign', 'prepare-message', { ...job.data, emailId: campaignEmail.id }, `campaign:${company.id}`);
  await maybeRefresh(company.run_id);
}, config.ENRICHMENT_CONCURRENCY);

addWorker('campaign', async (job: Job<CompanyJob & { emailId: string }>) => {
  const lead = await eligibleEmail(job.data.emailId);
  if (!lead) return;
  const firstName = String(lead.full_name).split(' ')[0];
  const subject = `A quick idea for ${lead.company_name}`;
  const painPoint = Array.isArray(lead.pain_points) ? lead.pain_points[0] : undefined;
  const body = `Hi ${firstName},\n\nI came across ${lead.company_name} and noticed ${painPoint ?? 'an opportunity to improve the customer journey'}. Would a short, no-pressure review be useful?\n\nIf this is not relevant, reply unsubscribe and I will not contact you again.`;
  if (await isRunCancelled(lead.run_id)) return { cancelled: true };
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
  const raw = company.raw_data as Record<string, unknown> | undefined;
  const emails = [
    ...parseStringList(raw?.emails),
    ...parseStringList(raw?.email),
    ...parseStringList(raw?.Email),
    ...parseStringList(raw?.Emails),
  ];
  return {
    sourceId: company.source_id, name: company.name, category: company.category,
    categories: company.categories, country: company.country, city: company.city,
    address: company.address, phone: company.phone, website: company.website,
    rating: company.rating == null ? undefined : Number(company.rating), reviewCount: company.review_count,
    latitude: company.latitude, longitude: company.longitude,
    publicEmails: [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))],
    owner: parseOwner(raw?.owner), raw,
  };
}

async function maybeRefresh(runId: string, force = false) {
  const previous = refreshCounters.get(runId) ?? { count: 0, refreshedAt: 0 };
  const next = { count: previous.count + 1, refreshedAt: previous.refreshedAt };
  if (force || next.count % 3 === 0 || Date.now() - next.refreshedAt >= 1_500) {
    await refreshRunStats(runId);
    next.refreshedAt = Date.now();
  }
  refreshCounters.set(runId, next);
}

async function finishOne(runId: string) {
  await maybeRefresh(runId);
  await maybeCompleteRun(runId);
}

let reconciling = false;
async function reconcile() {
  if (reconciling) return;
  reconciling = true;
  try { await reconcileActiveRuns(); }
  catch (error) { console.error('Pipeline recovery failed:', error); }
  finally { reconciling = false; }
}
const recoveryTimer = setInterval(() => void reconcile(), 30_000);
void reconcile();

async function shutdown(signal: string) {
  clearInterval(recoveryTimer);
  console.log(`Received ${signal}; closing workers`);
  await Promise.all(workers.map((worker) => worker.close()));
  await closeQueues();
  await closeDatabase();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
console.log(`LeadForge workers started in ${config.PROVIDER_MODE} mode`);
