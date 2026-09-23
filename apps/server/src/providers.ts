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
      email: true,
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
  const owner = parseOwner(row.owner);
  return {
    sourceId: stringValue(row.place_id ?? row.cid),
    name: stringValue(row.title ?? row.name) || 'Unknown business',
    category: stringValue(row.category),
    categories: Array.isArray(row.categories) ? row.categories.map(String) : [],
    country: stringValue(row.country) ?? '', city: stringValue(row.city), address: stringValue(row.address),
    phone: stringValue(row.phone), website: stringValue(row.web_site ?? row.website),
    rating: numberValue(row.review_rating ?? row.rating), reviewCount: numberValue(row.reviews ?? row.review_count),
    latitude: numberValue(row.latitude), longitude: numberValue(row.longitude),
    publicEmails: parseStringList(row.emails), owner, raw: row,
  };
}

export type ContactEvidenceSource = {
  kind: 'email' | 'phone' | 'social'; value: string; sourceType: string; sourceUrl?: string;
};

export type WebsiteEvidence = {
  title: string; description: string; about: string; services: string[]; emails: string[]; phones: string[];
  socialLinks: string[]; technologies: string[]; hasContactForm: boolean; hasBooking: boolean;
  hasPayment: boolean; pagesCrawled: number; usedBrowser: boolean; textSample: string;
  contactSources: ContactEvidenceSource[];
};

export async function crawlWebsite(candidate: BusinessCandidate): Promise<WebsiteEvidence> {
  if (config.PROVIDER_MODE === 'safe') {
    const seed = candidate.name.length + (candidate.reviewCount ?? 0);
    return {
      title: candidate.name, description: `${candidate.name} provides ${candidate.category ?? 'business'} services.`,
      about: `Established local business serving ${candidate.city ?? candidate.country}.`,
      services: [candidate.category ?? 'Professional services'], emails: candidate.publicEmails ?? [],
      phones: candidate.phone ? [candidate.phone] : [],
      socialLinks: [], technologies: ['Demo CMS'], hasContactForm: seed % 3 !== 0,
      hasBooking: seed % 4 === 0, hasPayment: seed % 5 === 0, pagesCrawled: 3,
      usedBrowser: false, textSample: `${candidate.name} services contact about`,
      contactSources: [
        ...(candidate.publicEmails ?? []).map((value) => ({ kind: 'email' as const, value, sourceType: 'google_maps' })),
        ...(candidate.phone ? [{ kind: 'phone' as const, value: candidate.phone, sourceType: 'google_maps' }] : []),
      ],
    };
  }
  if (!candidate.website) throw new Error('Cannot crawl a company without a website');

  const root = new URL(candidate.website.includes('://') ? candidate.website : `https://${candidate.website}`);
  const urls = [root.toString()];
  const documents: Array<{ url: string; html: string }> = [];
  for (let index = 0; index < urls.length && documents.length < config.MAX_PAGES_PER_SITE; index += 1) {
    try {
      const url = urls[index]!;
      const response = await fetch(url, {
        headers: { 'user-agent': 'LeadForgeResearchBot/1.0 (+business-research)' },
        redirect: 'follow', signal: AbortSignal.timeout(10_000),
      });
      if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
        const html = (await response.text()).slice(0, 1_000_000);
        documents.push({ url, html });
        const $ = load(html);
        $('a[href]').each((_, node) => {
          const href = $(node).attr('href');
          const label = $(node).text();
          if (!href || !/contact|about|team|staff|services|booking|support/i.test(`${href} ${label}`)) return;
          try {
            const discovered = new URL(href, root);
            discovered.hash = ''; discovered.search = '';
            if (discovered.origin === root.origin && !urls.includes(discovered.toString())) urls.push(discovered.toString());
          } catch { /* ignore malformed links */ }
        });
      }
    } catch { /* one broken page must not fail the company */ }
  }
  let evidence = documents.length ? extractEvidence(documents, candidate) : undefined;
  if (!evidence || evidence.textSample.length < 500) {
    const rendered = await renderWithBrowser(root.toString());
    evidence = extractEvidence([{ url: root.toString(), html: rendered }], candidate);
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

function extractEvidence(documents: Array<{ url: string; html: string }>, candidate: BusinessCandidate): WebsiteEvidence {
  const texts: string[] = [];
  const emails = new Set<string>(candidate.publicEmails ?? []);
  const phones = new Set<string>(candidate.phone ? [candidate.phone] : []);
  const socialLinks = new Set<string>();
  const services = new Set<string>();
  const contactSources = new Map<string, ContactEvidenceSource>();
  for (const email of candidate.publicEmails ?? []) addContactSource(contactSources, { kind: 'email', value: email, sourceType: 'google_maps' });
  if (candidate.phone) addContactSource(contactSources, { kind: 'phone', value: candidate.phone, sourceType: 'google_maps' });
  let title = ''; let description = ''; let hasContactForm = false; let hasBooking = false; let hasPayment = false;
  for (const document of documents) {
    const $ = load(document.html);
    $('script,style,noscript,svg').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim();
    texts.push(text.slice(0, 12_000));
    title ||= $('title').first().text().trim();
    description ||= $('meta[name="description"]').attr('content')?.trim() ?? '';
    $('a[href^="mailto:"]').each((_, node) => {
      const value = normalizeEmail($(node).attr('href')?.slice(7).split('?')[0]);
      if (value) { emails.add(value); addContactSource(contactSources, { kind: 'email', value, sourceType: 'company_website', sourceUrl: document.url }); }
    });
    $('a[href^="tel:"]').each((_, node) => {
      const value = normalizePhone($(node).attr('href')?.slice(4));
      if (value) { phones.add(value); addContactSource(contactSources, { kind: 'phone', value, sourceType: 'company_website', sourceUrl: document.url }); }
    });
    $('a[href]').each((_, node) => {
      const href = $(node).attr('href') ?? '';
      if (/linkedin|facebook|instagram|x\.com|twitter/i.test(href)) {
        socialLinks.add(href);
        addContactSource(contactSources, { kind: 'social', value: href, sourceType: 'company_website', sourceUrl: document.url });
      }
      const label = $(node).text().replace(/\s+/g, ' ').trim();
      if (/service/i.test(href) && label.length > 2 && label.length < 80) services.add(label);
    });
    hasContactForm ||= $('form input[type="email"], form textarea').length > 0;
    hasBooking ||= /book now|schedule|appointment|calendly/i.test(text);
    hasPayment ||= /checkout|pay now|stripe|razorpay|paypal/i.test(`${text} ${document.html}`);
    for (const value of extractEmails(text)) {
      emails.add(value); addContactSource(contactSources, { kind: 'email', value, sourceType: 'company_website', sourceUrl: document.url });
    }
    for (const value of extractPhones(text)) {
      phones.add(value); addContactSource(contactSources, { kind: 'phone', value, sourceType: 'company_website', sourceUrl: document.url });
    }
  }
  const combined = texts.join(' ').slice(0, 24_000);
  return {
    title, description, about: combined.slice(0, 2_000), services: [...services].slice(0, 20),
    emails: [...emails].slice(0, 20), phones: [...phones].slice(0, 20),
    socialLinks: [...socialLinks].slice(0, 20), technologies: [],
    hasContactForm, hasBooking, hasPayment, pagesCrawled: documents.length, usedBrowser: false,
    textSample: combined.slice(0, 8_000), contactSources: [...contactSources.values()].slice(0, 60),
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
    recommendedRole: 'Owner', rationale: buildQualificationRationale(candidate, evidence, fallback.painPoints), model: 'rules-live-fallback',
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
    publicEmailsFound: Array.isArray(evidence.emails) ? evidence.emails.length : 0,
    publicPhonesFound: Array.isArray(evidence.phones) ? evidence.phones.length : 0,
    socialProfilesFound: Array.isArray(evidence.social_links) ? evidence.social_links.length : 0,
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
          { role: 'system', content: 'Qualify only from supplied evidence. Never invent facts. The rationale must clearly explain in 1-3 concise sentences why this business is or is not a potential client, citing observed website/business signals and the proposed opportunity. Return strict JSON.' },
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

type PublicSearchResult = { title?: string; url?: string; content?: string };

export type PublicContactResearch = {
  emails: string[];
  phones: string[];
  socialLinks: string[];
  sources: ContactEvidenceSource[];
  searchResults: PublicSearchResult[];
};

export async function researchPublicContacts(candidate: BusinessCandidate, evidence?: Record<string, unknown>): Promise<PublicContactResearch> {
  const emails = new Set<string>(candidate.publicEmails ?? []);
  const phones = new Set<string>(candidate.phone ? [candidate.phone] : []);
  const socialLinks = new Set<string>();
  const sources = new Map<string, ContactEvidenceSource>();
  const storedSources = Array.isArray(evidence?.contact_sources) ? evidence.contact_sources as ContactEvidenceSource[] : [];
  for (const source of storedSources) addContactSource(sources, source);
  for (const email of [...(candidate.publicEmails ?? []), ...stringArray(evidence?.emails)]) {
    const normalized = normalizeEmail(email);
    if (normalized) {
      emails.add(normalized);
      addContactSource(sources, { kind: 'email', value: normalized, sourceType: candidate.publicEmails?.includes(email) ? 'google_maps' : 'company_website', ...(candidate.website ? { sourceUrl: candidate.website } : {}) });
    }
  }
  for (const phone of [candidate.phone, ...stringArray(evidence?.phones)]) {
    const normalized = normalizePhone(phone);
    if (normalized) {
      phones.add(normalized);
      addContactSource(sources, { kind: 'phone', value: normalized, sourceType: phone === candidate.phone ? 'google_maps' : 'company_website', ...(candidate.website ? { sourceUrl: candidate.website } : {}) });
    }
  }
  for (const url of stringArray(evidence?.social_links)) {
    socialLinks.add(url);
    addContactSource(sources, { kind: 'social', value: url, sourceType: 'company_website', ...(candidate.website ? { sourceUrl: candidate.website } : {}) });
  }
  if (config.PROVIDER_MODE === 'safe') return { emails: [...emails], phones: [...phones], socialLinks: [...socialLinks], sources: [...sources.values()], searchResults: [] };

  const domain = normalizeDomain(candidate.website);
  const location = [candidate.city, candidate.country].filter(Boolean).join(' ');
  const queries = [
    `"${candidate.name}" email contact ${location}`,
    `"${candidate.name}" gmail phone ${location}`,
    `"${candidate.name}" owner founder director ${location}`,
    ...(domain ? [`site:${domain} email contact`] : [`"${candidate.name}" facebook instagram ${location}`]),
  ];
  const settled = await Promise.allSettled(queries.map((query) => searchPublicWeb(query)));
  const searchResults = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []).slice(0, 60);
  for (const result of searchResults) {
    const sourceUrl = result.url;
    const text = deobfuscateContactText(`${result.title ?? ''} ${result.content ?? ''} ${sourceUrl ?? ''}`);
    const sourceType = sourceUrl && /(?:linkedin|facebook|instagram|x\.com|twitter)\./i.test(sourceUrl) ? 'social_search' : 'public_search';
    if (sourceUrl && sourceType === 'social_search') {
      socialLinks.add(sourceUrl);
      addContactSource(sources, { kind: 'social', value: sourceUrl, sourceType, sourceUrl });
    }
    for (const email of extractEmails(text)) {
      emails.add(email);
      addContactSource(sources, { kind: 'email', value: email, sourceType, ...(sourceUrl ? { sourceUrl } : {}) });
    }
    for (const phone of extractPhones(text)) {
      phones.add(phone);
      addContactSource(sources, { kind: 'phone', value: phone, sourceType, ...(sourceUrl ? { sourceUrl } : {}) });
    }
  }
  return {
    emails: [...emails].slice(0, 30), phones: [...phones].slice(0, 30), socialLinks: [...socialLinks].slice(0, 30),
    sources: [...sources.values()].slice(0, 100), searchResults,
  };
}

export async function findDecisionMaker(candidate: BusinessCandidate, role = 'Owner', suppliedResults: PublicSearchResult[] = []) {
  if (config.PROVIDER_MODE === 'safe') {
    const names = ['Aarav Sharma', 'Isha Patel', 'Rohan Das', 'Meera Singh', 'Arjun Rao'];
    return { fullName: names[candidate.name.length % names.length]!, role, sourceUrl: candidate.website, confidence: 76 };
  }
  if (candidate.owner?.name) return { fullName: candidate.owner.name, role, sourceUrl: candidate.owner.sourceUrl, confidence: 82 };
  const results = suppliedResults.length ? suppliedResults : await searchPublicWeb(`"${candidate.name}" ${role} ${candidate.city ?? ''}`);
  const result = results.find((item) => item.title && /owner|founder|director|ceo/i.test(`${item.title} ${item.content}`));
  if (!result) return undefined;
  const clean = (result.title ?? '').replace(/\s*[|–—-].*$/, '').replace(/\b(owner|founder|director|ceo)\b/ig, '').trim();
  if (clean.split(/\s+/).length < 2) return undefined;
  return { fullName: clean.slice(0, 100), role, sourceUrl: result.url, confidence: 55 };
}

export async function enrichEmails(candidate: BusinessCandidate, fullName: string, publicSources: ContactEvidenceSource[] = [], harvested: string[] = []) {
  const domain = normalizeDomain(candidate.website);
  const candidates = new Map<string, ContactEvidenceSource>();
  for (const source of publicSources.filter((item) => item.kind === 'email')) {
    const address = normalizeEmail(source.value);
    if (address) candidates.set(address, { ...source, value: address });
  }
  for (const address of [...(candidate.publicEmails ?? []), ...harvested]) {
    const normalized = normalizeEmail(address);
    if (normalized && !candidates.has(normalized)) candidates.set(normalized, {
      kind: 'email', value: normalized, sourceType: candidate.publicEmails?.includes(address) ? 'google_maps' : 'company_website',
      ...(candidate.website ? { sourceUrl: candidate.website } : {}),
    });
  }
  const tokens = fullName.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
  const first = tokens[0]; const last = tokens.at(-1);
  if (domain && first && last && normalizeNameForComparison(fullName) !== normalizeNameForComparison(candidate.name)) {
    const generated = `${first}.${last}@${domain}`;
    if (!candidates.has(generated)) candidates.set(generated, { kind: 'email', value: generated, sourceType: 'generated_pattern' });
  }
  const results: Array<{ address: string; status: string; method: string; confidence: number; evidence: Record<string, unknown> }> = [];
  const mxCache = new Map<string, Awaited<ReturnType<typeof dns.resolveMx>> | undefined>();
  for (const source of [...candidates.values()].slice(0, 12)) {
    const address = source.value;
    const addressDomain = address.split('@')[1];
    if (!addressDomain) continue;
    if (config.PROVIDER_MODE === 'safe') {
      results.push({ address, status: 'valid', method: 'safe_mode', confidence: 90, evidence: { ...source, public: true } });
      continue;
    }
    try {
      let mx = mxCache.get(addressDomain);
      if (!mxCache.has(addressDomain)) { mx = await dns.resolveMx(addressDomain); mxCache.set(addressDomain, mx); }
      if (!mx?.length) {
        results.push({ address, status: 'invalid', method: 'dns_mx', confidence: 95, evidence: { ...source, reason: 'No MX records' } });
        continue;
      }
      const firstParty = ['company_website', 'google_maps'].includes(source.sourceType);
      const generated = source.sourceType === 'generated_pattern';
      results.push({
        address, status: firstParty ? 'valid' : 'risky',
        method: generated ? 'pattern_and_mx' : `${source.sourceType}_and_mx`,
        confidence: firstParty ? 94 : generated ? 55 : 76,
        evidence: { ...source, public: !generated, mx: mx.map((entry) => entry.exchange) },
      });
    } catch {
      results.push({ address, status: 'invalid', method: 'dns_mx', confidence: 90, evidence: { ...source, reason: 'MX lookup failed' } });
    }
  }
  return results.sort((left, right) => right.confidence - left.confidence);
}

export async function enrichEmail(candidate: BusinessCandidate, fullName: string, harvested: string[] = []) {
  return (await enrichEmails(candidate, fullName, [], harvested))[0];
}

async function legacyFindDecisionMaker(candidate: BusinessCandidate, role = 'Owner') {
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

async function legacyEnrichEmail(candidate: BusinessCandidate, fullName: string, harvested: string[] = []) {
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

async function searchPublicWeb(query: string): Promise<PublicSearchResult[]> {
  const response = await fetch(`${config.SEARXNG_URL}/search?format=json&q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`SearXNG error ${response.status}`);
  const data = await response.json() as { results?: PublicSearchResult[] };
  return (data.results ?? []).slice(0, 20);
}

export function parseOwner(value: unknown): BusinessCandidate['owner'] {
  if (!value) return undefined;
  let record: Record<string, unknown>;
  try { record = typeof value === 'string' ? JSON.parse(value) as Record<string, unknown> : value as Record<string, unknown>; }
  catch { return undefined; }
  const name = String(record.name ?? '').replace(/\s*\((?:owner|manager)\)\s*$/i, '').trim();
  if (!name) return undefined;
  const sourceUrl = stringValue(record.link);
  return { name, ...(sourceUrl ? { sourceUrl } : {}) };
}

export function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value !== 'string' || !value.trim() || value.trim() === '[]') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.map(String).map((item) => item.trim()).filter(Boolean);
  } catch { /* accept comma- and semicolon-separated provider values */ }
  return value.split(/[;,\n]/).map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim().toLowerCase().replace(/^mailto:/, '').split('?')[0];
  if (!email || email.length > 254 || !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)) return undefined;
  if (/(?:example|domain|email)\.(?:com|org|net)$/.test(email.split('@')[1] ?? '')) return undefined;
  return email;
}

function normalizePhone(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/^tel:/i, '');
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15 || /^(\d)\1+$/.test(digits)) return undefined;
  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

export function extractEmails(value: string): string[] {
  const text = deobfuscateContactText(value);
  const found = new Set<string>();
  for (const match of text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
    const email = normalizeEmail(match[0]);
    if (email) found.add(email);
  }
  return [...found];
}

export function extractPhones(value: string): string[] {
  const found = new Set<string>();
  for (const match of value.matchAll(/(?:\+?\d|\(\d)[\d\s().-]{6,}\d/g)) {
    const phone = normalizePhone(match[0]);
    if (phone) found.add(phone);
  }
  return [...found];
}

function deobfuscateContactText(value: string): string {
  return value
    .replace(/\s*(?:\[|\()\s*at\s*(?:\]|\))\s*/gi, '@')
    .replace(/\s+(?:at)\s+(?=[a-z0-9.-]+\s*(?:\[|\(|\s)dot)/gi, '@')
    .replace(/\s*(?:\[|\()\s*dot\s*(?:\]|\))\s*/gi, '.')
    .replace(/\s+dot\s+(?=[a-z]{2,}\b)/gi, '.');
}

function addContactSource(target: Map<string, ContactEvidenceSource>, source: ContactEvidenceSource) {
  if (!source?.kind || !source.value || !source.sourceType) return;
  const normalizedValue = source.kind === 'email' ? normalizeEmail(source.value)
    : source.kind === 'phone' ? normalizePhone(source.value) : source.value.trim();
  if (!normalizedValue) return;
  const normalized = { ...source, value: normalizedValue };
  target.set(`${normalized.kind}:${normalized.value}:${normalized.sourceUrl ?? ''}`, normalized);
}

function normalizeNameForComparison(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function buildQualificationRationale(candidate: BusinessCandidate, evidence: Record<string, unknown> | undefined, painPoints: string[]) {
  const signals: string[] = [];
  if (!candidate.website) signals.push('no business website was detected');
  else if (!evidence?.has_booking) signals.push('the website has no detected online booking flow');
  if (candidate.phone) signals.push('the business has a public contact number');
  if ((candidate.reviewCount ?? 0) >= 30) signals.push(`${candidate.reviewCount} Google reviews indicate an established active business`);
  if (evidence?.has_contact_form === false) signals.push('no contact form was detected');
  const observed = signals.slice(0, 3).join('; ') || 'the available public evidence is limited';
  return `Potential-client assessment: ${observed}. The clearest opportunity is ${painPoints[0]?.toLowerCase() ?? 'a review of the website conversion path'}.`;
}

function titleCase(value: string) { return value.replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function stringValue(value: unknown) { return value == null ? undefined : String(value); }
function numberValue(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined; }
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (character) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' })[character]!); }
function delay(milliseconds: number) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
