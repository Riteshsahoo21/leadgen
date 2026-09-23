import dns from 'node:dns/promises';
import { load } from 'cheerio';
import { parse } from 'csv-parse/sync';
import { config } from './config.js';
import { normalizeDomain, opportunityFor, type BusinessCandidate, type CreateRunInput } from './domain.js';

const serviceWords = ['Studio', 'Works', 'Collective', 'Partners', 'Solutions', 'House', 'Company'];

export function safeBusinesses(input: CreateRunInput): BusinessCandidate[] {
  const combinations = input.cities.flatMap((city) => input.businessTypes.map((businessType) => ({ city, businessType })));
  const target = Math.min(input.targetCount, config.MAX_DISCOVERY_RESULTS);
  return Array.from({ length: target }, (_, index) => {
    const combination = combinations[index % combinations.length]!;
    const serial = index + 1;
    const slug = `${combination.businessType}-${combination.city}-${serial}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const hasWebsite = index % 4 !== 0;
    return {
      sourceId: `demo-${slug}`,
      name: `${combination.city} ${titleCase(combination.businessType)} ${serviceWords[index % serviceWords.length]} ${serial}`,
      category: combination.businessType,
      categories: [combination.businessType],
      country: input.country,
      city: combination.city,
      address: `${20 + (index % 180)} Market Road, ${combination.city}`,
      phone: index % 9 === 0 ? undefined : `+91 98${String(10_000_000 + index).padStart(8, '0')}`,
      website: hasWebsite ? `https://${slug}.example.com` : undefined,
      rating: 3.4 + (index % 15) / 10,
      reviewCount: 8 + ((index * 37) % 480),
      raw: { demo: true },
    };
  });
}

export async function discoverBusinesses(input: CreateRunInput): Promise<BusinessCandidate[]> {
  if (config.PROVIDER_MODE === 'safe') return safeBusinesses(input);

  const keywords = input.cities.flatMap((city) => input.businessTypes.map((type) => `${type} in ${city}, ${input.country}`));
  const response = await fetch(`${config.GMAPS_API_URL}/api/v1/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: input.name,
      keywords,
      lang: 'en',
      depth: 1,
      max_time: 180,
      max_results: Math.min(input.targetCount, config.MAX_DISCOVERY_RESULTS),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Maps service rejected the job (${response.status}): ${await response.text()}`);
  const payload = await response.json() as Record<string, any>;
  const immediateResults = payload.results ?? payload.Results;
  if (Array.isArray(immediateResults)) return immediateResults.map(mapMapsResult).slice(0, input.targetCount);
  const jobId = String(payload.id ?? payload.ID ?? payload.job_id ?? payload.job?.id ?? '');
  if (!jobId) throw new Error('Maps service returned neither results nor a job ID');
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await delay(10_000);
    const statusResponse = await fetch(`${config.GMAPS_API_URL}/api/v1/jobs/${encodeURIComponent(jobId)}`, { signal: AbortSignal.timeout(15_000) });
    if (!statusResponse.ok) throw new Error(`Maps job status failed (${statusResponse.status})`);
    const statusPayload = await statusResponse.json() as Record<string, any>;
    const statusResults = statusPayload.results ?? statusPayload.Results;
    if (Array.isArray(statusResults)) return statusResults.map(mapMapsResult).slice(0, input.targetCount);
    const status = String(statusPayload.status ?? statusPayload.Status ?? statusPayload.state ?? statusPayload.State ?? '').toLowerCase();
    if (['failed', 'error', 'cancelled'].includes(status)) throw new Error(`Maps job ${jobId} ${status}: ${statusPayload.error ?? ''}`);
    if (['completed', 'complete', 'done', 'success', 'succeeded', 'ok'].includes(status)) {
      const download = await fetch(`${config.GMAPS_API_URL}/api/v1/jobs/${encodeURIComponent(jobId)}/download`, { signal: AbortSignal.timeout(30_000) });
      if (!download.ok) throw new Error(`Maps result download failed (${download.status})`);
      const rows = parse(await download.text(), { columns: true, skip_empty_lines: true, relax_column_count: true }) as unknown[];
      return rows.map(mapMapsResult).slice(0, input.targetCount);
    }
  }
  throw new Error(`Maps job ${jobId} did not complete within 30 minutes`);
}

function mapMapsResult(item: unknown): BusinessCandidate {
  const row = item as Record<string, unknown>;
  return {
    sourceId: stringValue(row.place_id ?? row.cid),
    name: stringValue(row.title ?? row.name) || 'Unknown business',
    category: stringValue(row.category),
    categories: Array.isArray(row.categories) ? row.categories.map(String) : [],
    country: stringValue(row.country) ?? '', city: stringValue(row.city), address: stringValue(row.address),
    phone: stringValue(row.phone), website: stringValue(row.web_site ?? row.website),
    rating: numberValue(row.review_rating ?? row.rating), reviewCount: numberValue(row.reviews ?? row.review_count),
    latitude: numberValue(row.latitude), longitude: numberValue(row.longitude), raw: row,
  };
}

export type WebsiteEvidence = {
  title: string; description: string; about: string; services: string[]; emails: string[];
  socialLinks: string[]; technologies: string[]; hasContactForm: boolean; hasBooking: boolean;
  hasPayment: boolean; pagesCrawled: number; usedBrowser: boolean; textSample: string;
};

export async function crawlWebsite(candidate: BusinessCandidate): Promise<WebsiteEvidence> {
  if (config.PROVIDER_MODE === 'safe') {
    const seed = candidate.name.length + (candidate.reviewCount ?? 0);
    return {
      title: candidate.name, description: `${candidate.name} provides ${candidate.category ?? 'business'} services.`,
      about: `Established local business serving ${candidate.city ?? candidate.country}.`,
      services: [candidate.category ?? 'Professional services'], emails: [],
      socialLinks: [], technologies: ['Demo CMS'], hasContactForm: seed % 3 !== 0,
      hasBooking: seed % 4 === 0, hasPayment: seed % 5 === 0, pagesCrawled: 3,
      usedBrowser: false, textSample: `${candidate.name} services contact about`,
    };
  }
  if (!candidate.website) throw new Error('Cannot crawl a company without a website');

  const root = new URL(candidate.website.includes('://') ? candidate.website : `https://${candidate.website}`);
  const paths = ['/', '/about', '/services', '/contact', '/booking'].slice(0, config.MAX_PAGES_PER_SITE);
  const documents: Array<{ url: string; html: string }> = [];
  for (const path of paths) {
    try {
      const url = new URL(path, root).toString();
      const response = await fetch(url, {
        headers: { 'user-agent': 'LeadForgeResearchBot/1.0 (+business-research)' },
        redirect: 'follow', signal: AbortSignal.timeout(10_000),
      });
      if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
        documents.push({ url, html: (await response.text()).slice(0, 1_000_000) });
      }
    } catch { /* one broken page must not fail the company */ }
  }
  let evidence = documents.length ? extractEvidence(documents) : undefined;
  if (!evidence || evidence.textSample.length < 500) {
    const rendered = await renderWithBrowser(root.toString());
    evidence = extractEvidence([{ url: root.toString(), html: rendered }]);
    evidence.usedBrowser = true;
  }
  return evidence;
}

let browserTail: Promise<unknown> = Promise.resolve();

function renderWithBrowser(url: string): Promise<string> {
  const task = browserTail.then(async () => {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({
      headless: true, executablePath: config.CHROMIUM_PATH,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    try {
      const page = await browser.newPage({ javaScriptEnabled: true });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForTimeout(1_000);
      return (await page.content()).slice(0, 1_000_000);
    } finally {
      await browser.close();
    }
  });
  browserTail = task.then(() => undefined, () => undefined);
  return task;
}

function extractEvidence(documents: Array<{ url: string; html: string }>): WebsiteEvidence {
  const texts: string[] = [];
  const emails = new Set<string>();
  const socialLinks = new Set<string>();
  const services = new Set<string>();
  let title = ''; let description = ''; let hasContactForm = false; let hasBooking = false; let hasPayment = false;
  for (const document of documents) {
    const $ = load(document.html);
    $('script,style,noscript,svg').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim();
    texts.push(text.slice(0, 12_000));
    title ||= $('title').first().text().trim();
    description ||= $('meta[name="description"]').attr('content')?.trim() ?? '';
    $('a[href^="mailto:"]').each((_, node) => { const value = $(node).attr('href')?.slice(7).split('?')[0]; if (value) emails.add(value.toLowerCase()); });
    $('a[href]').each((_, node) => {
      const href = $(node).attr('href') ?? '';
      if (/linkedin|facebook|instagram|x\.com|twitter/i.test(href)) socialLinks.add(href);
      const label = $(node).text().replace(/\s+/g, ' ').trim();
      if (/service/i.test(href) && label.length > 2 && label.length < 80) services.add(label);
    });
    hasContactForm ||= $('form input[type="email"], form textarea').length > 0;
    hasBooking ||= /book now|schedule|appointment|calendly/i.test(text);
    hasPayment ||= /checkout|pay now|stripe|razorpay|paypal/i.test(`${text} ${document.html}`);
    for (const match of text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) emails.add(match[0].toLowerCase());
  }
  const combined = texts.join(' ').slice(0, 24_000);
  return {
    title, description, about: combined.slice(0, 2_000), services: [...services].slice(0, 20),
    emails: [...emails].slice(0, 20), socialLinks: [...socialLinks].slice(0, 20), technologies: [],
    hasContactForm, hasBooking, hasPayment, pagesCrawled: documents.length, usedBrowser: false,
    textSample: combined.slice(0, 8_000),
  };
}

export async function qualifyBusiness(candidate: BusinessCandidate, evidence?: Record<string, unknown>) {
  const fallback = opportunityFor(candidate, {
    hasBooking: Boolean(evidence?.has_booking), hasContactForm: Boolean(evidence?.has_contact_form),
  });
  const baseline = Math.min(98, 42 + (candidate.phone ? 10 : 0) + ((candidate.reviewCount ?? 0) > 30 ? 14 : 0)
    + (!candidate.website ? 24 : 8) + (!evidence?.has_booking ? 6 : 0));
  const ruleResult = {
    qualified: baseline >= config.MIN_QUALIFICATION_SCORE, score: baseline, ...fallback,
    recommendedRole: 'Owner', rationale: 'Evidence-based qualification using deterministic scoring.', model: 'rules-live-fallback',
  };
  if (config.PROVIDER_MODE === 'safe') return {
    ...ruleResult, rationale: 'Deterministic safe-mode qualification using stored evidence.', model: 'rules-safe-mode',
  };

  const schema = {
    type: 'object', required: ['qualified','score','opportunity','pain_points','recommended_role','rationale'],
    properties: {
      qualified: { type: 'boolean' }, score: { type: 'integer', minimum: 0, maximum: 100 },
      opportunity: { type: 'string' }, pain_points: { type: 'array', items: { type: 'string' }, maxItems: 5 },
      recommended_role: { type: 'string' }, rationale: { type: 'string' },
    },
  };
  const compactEvidence = evidence ? {
    title: evidence.title,
    description: evidence.description,
    about: String(evidence.about ?? '').slice(0, 800),
    services: evidence.services,
    hasContactForm: evidence.has_contact_form,
    hasBooking: evidence.has_booking,
    hasPayment: evidence.has_payment,
    pagesCrawled: evidence.pages_crawled,
    textSample: String(evidence.text_sample ?? '').slice(0, 1_800),
  } : null;
  const compactCompany = {
    name: candidate.name, category: candidate.category, categories: candidate.categories,
    country: candidate.country, city: candidate.city, hasPhone: Boolean(candidate.phone),
    hasWebsite: Boolean(candidate.website), rating: candidate.rating, reviewCount: candidate.reviewCount,
  };
  try {
    const response = await fetch(`${config.OLLAMA_URL}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(300_000),
      body: JSON.stringify({ model: config.OLLAMA_MODEL, stream: false, think: false, format: schema, keep_alive: 0,
        options: { temperature: 0.1, num_ctx: 2048, num_predict: 256 }, messages: [
          { role: 'system', content: 'Qualify only from supplied evidence. Never invent facts. Return concise strict JSON.' },
          { role: 'user', content: JSON.stringify({ company: compactCompany, websiteEvidence: compactEvidence }) },
        ] }),
    });
    if (!response.ok) throw new Error(`Ollama error ${response.status}`);
    const data = await response.json() as { message?: { content?: string } };
    const parsed = JSON.parse(data.message?.content ?? '{}') as Record<string, unknown>;
    const score = Math.max(0, Math.min(100, Number(parsed.score ?? 0)));
    return {
      qualified: Boolean(parsed.qualified) && score >= config.MIN_QUALIFICATION_SCORE, score,
      opportunity: String(parsed.opportunity ?? fallback.opportunity),
      painPoints: Array.isArray(parsed.pain_points) ? parsed.pain_points.map(String).slice(0, 5) : fallback.painPoints,
      recommendedRole: String(parsed.recommended_role ?? 'Owner'), rationale: String(parsed.rationale ?? ''), model: config.OLLAMA_MODEL,
    };
  } catch (error) {
    console.warn(`Ollama qualification unavailable for ${candidate.name}; using rule fallback:`, error instanceof Error ? error.message : error);
    return ruleResult;
  }
}

export async function findDecisionMaker(candidate: BusinessCandidate, role = 'Owner') {
  if (config.PROVIDER_MODE === 'safe') {
    const names = ['Aarav Sharma', 'Isha Patel', 'Rohan Das', 'Meera Singh', 'Arjun Rao'];
    return { fullName: names[candidate.name.length % names.length]!, role, sourceUrl: candidate.website, confidence: 76 };
  }
  const query = `"${candidate.name}" ${role} ${candidate.city ?? ''}`;
  const response = await fetch(`${config.SEARXNG_URL}/search?format=json&q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`SearXNG error ${response.status}`);
  const data = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
  const result = data.results?.find((item) => item.title && new RegExp(`owner|founder|director|ceo`, 'i').test(`${item.title} ${item.content}`));
  if (!result) return undefined;
  const clean = (result.title ?? '').replace(/\s*[|–—-].*$/, '').replace(/\b(owner|founder|director|ceo)\b/ig, '').trim();
  if (clean.split(/\s+/).length < 2) return undefined;
  return { fullName: clean.slice(0, 100), role, sourceUrl: result.url, confidence: 55 };
}

export async function enrichEmail(candidate: BusinessCandidate, fullName: string, harvested: string[] = []) {
  const domain = normalizeDomain(candidate.website);
  if (!domain) return undefined;
  const tokens = fullName.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
  const first = tokens[0]; const last = tokens.at(-1);
  if (!first || !last) return undefined;
  const matchingPublic = harvested.find((email) => email.split('@')[0]?.includes(first));
  const address = matchingPublic ?? `${first}.${last}@${domain}`;
  if (config.PROVIDER_MODE === 'safe') return { address, status: 'valid', method: 'safe_mode', confidence: matchingPublic ? 94 : 78, evidence: { harvested: Boolean(matchingPublic) } };
  try {
    const mx = await dns.resolveMx(domain);
    if (mx.length === 0) return { address, status: 'invalid', method: 'dns_mx', confidence: 95, evidence: { reason: 'No MX records' } };
    return { address, status: matchingPublic ? 'valid' : 'risky', method: matchingPublic ? 'public_and_mx' : 'pattern_and_mx', confidence: matchingPublic ? 94 : 58, evidence: { mx: mx.map((entry) => entry.exchange) } };
  } catch {
    return { address, status: 'invalid', method: 'dns_mx', confidence: 90, evidence: { reason: 'MX lookup failed' } };
  }
}

export async function sendWithPosta(to: string, subject: string, body: string) {
  const response = await fetch(`${config.POSTA_URL}/api/v1/emails/send`, {
    method: 'POST', signal: AbortSignal.timeout(30_000), headers: {
      'content-type': 'application/json', authorization: `Bearer ${config.POSTA_API_KEY}`,
    },
    body: JSON.stringify({ from: config.POSTA_FROM, to: [to], subject, html: `<p>${escapeHtml(body).replace(/\n/g, '<br>')}</p>` }),
  });
  if (!response.ok) throw new Error(`Posta error ${response.status}: ${await response.text()}`);
  return response.json() as Promise<{ id: string; status: string }>;
}

function titleCase(value: string) { return value.replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function stringValue(value: unknown) { return value == null ? undefined : String(value); }
function numberValue(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined; }
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (character) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' })[character]!); }
function delay(milliseconds: number) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
