import dns from 'node:dns/promises';
import { load } from 'cheerio';
import { parse } from 'csv-parse/sync';
import { config } from './config.js';
import { calculateQualificationScore, normalizeDomain, type BusinessCandidate, type CreateRunInput } from './domain.js';

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

export async function discoverBusinesses(
  input: CreateRunInput,
  shouldStop?: () => Promise<boolean>,
): Promise<BusinessCandidate[]> {
  if (config.PROVIDER_MODE === 'safe') return safeBusinesses(input);
  if (await shouldStop?.()) return [];

  const keywords = input.cities.flatMap((city) => input.businessTypes.map((type) => `${type} in ${city}, ${input.country}`));
  const depth = mapsDepthFor(input.targetCount, keywords.length);
  const response = await fetch(`${config.GMAPS_API_URL}/api/v1/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: input.name,
      keywords,
      lang: 'en',
      depth,
      email: true,
      max_time: Math.min(1_200, Math.max(300, depth * keywords.length * 12)),
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
    if (await shouldStop?.()) return [];
    await delay(10_000);
    if (await shouldStop?.()) return [];
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

export function mapsDepthFor(targetCount: number, keywordCount: number) {
  return Math.min(10, Math.max(1, Math.ceil(targetCount / Math.max(keywordCount, 1) / 15)));
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

export type CapabilitySignal = {
  status: 'detected' | 'not_detected' | 'unknown';
  sourceUrls: string[];
  evidence: string[];
};

export type WebsiteEvidence = {
  title: string; description: string; about: string; services: string[]; emails: string[]; phones: string[];
  socialLinks: string[]; technologies: string[]; hasContactForm: boolean; hasBooking: boolean;
  hasPayment: boolean; pagesCrawled: number; usedBrowser: boolean; textSample: string;
  contactSources: ContactEvidenceSource[];
  capabilities: Record<'contactForm' | 'booking' | 'onlinePurchase', CapabilitySignal>;
  pages: Array<{ url: string; title: string }>;
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
      capabilities: {
        contactForm: demoCapability(seed % 3 !== 0, 'Demo contact form'),
        booking: demoCapability(seed % 4 === 0, 'Demo booking flow'),
        onlinePurchase: demoCapability(seed % 5 === 0, 'Demo purchase flow'),
      },
      pages: [{ url: candidate.website ?? 'https://example.com', title: candidate.name }],
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
        const finalUrl = response.url || url;
        documents.push({ url: finalUrl, html });
        const $ = load(html);
        const discoveredLinks: Array<{ url: string; priority: number }> = [];
        $('a[href]').each((_, node) => {
          const href = $(node).attr('href');
          const label = $(node).text();
          const priority = pagePriority(`${href ?? ''} ${label}`);
          if (!href || priority === 0) return;
          try {
            const discovered = new URL(href, finalUrl);
            discovered.hash = ''; discovered.search = '';
            if (sameHostname(discovered, root) && !urls.includes(discovered.toString())) discoveredLinks.push({ url: discovered.toString(), priority });
          } catch { /* ignore malformed links */ }
        });
        discoveredLinks.sort((left, right) => right.priority - left.priority).forEach((item) => {
          if (!urls.includes(item.url)) urls.push(item.url);
        });
      }
    } catch { /* one broken page must not fail the company */ }
  }
  let evidence = documents.length ? extractEvidence(documents, candidate) : undefined;
  if (!evidence || evidence.textSample.length < 500) {
    try {
      const rendered = await renderWithBrowser(root.toString());
      const merged = [...documents.filter((document) => document.url !== root.toString()), { url: root.toString(), html: rendered }];
      evidence = extractEvidence(merged, candidate);
      evidence.usedBrowser = true;
    } catch (error) {
      if (!evidence) throw error;
    }
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

export function extractEvidence(documents: Array<{ url: string; html: string }>, candidate: BusinessCandidate): WebsiteEvidence {
  const texts: string[] = [];
  const emails = new Set<string>(candidate.publicEmails ?? []);
  const phones = new Set<string>(candidate.phone ? [candidate.phone] : []);
  const socialLinks = new Set<string>();
  const services = new Set<string>();
  const contactSources = new Map<string, ContactEvidenceSource>();
  const capabilityHits: Record<'contactForm' | 'booking' | 'onlinePurchase', { sourceUrls: Set<string>; evidence: Set<string> }> = {
    contactForm: { sourceUrls: new Set(), evidence: new Set() },
    booking: { sourceUrls: new Set(), evidence: new Set() },
    onlinePurchase: { sourceUrls: new Set(), evidence: new Set() },
  };
  const pages: Array<{ url: string; title: string }> = [];
  for (const email of candidate.publicEmails ?? []) addContactSource(contactSources, { kind: 'email', value: email, sourceType: 'google_maps' });
  if (candidate.phone) addContactSource(contactSources, { kind: 'phone', value: candidate.phone, sourceType: 'google_maps' });
  let title = ''; let description = ''; let hasContactForm = false; let hasBooking = false; let hasPayment = false;
  for (const document of documents) {
    const $ = load(document.html);
    extractStructuredData($, document.url, emails, phones, socialLinks, contactSources, services, capabilityHits);
    $('script,style,noscript,svg').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim();
    texts.push(text.slice(0, 12_000));
    const pageTitle = $('title').first().text().replace(/\s+/g, ' ').trim();
    pages.push({ url: document.url, title: pageTitle || new URL(document.url).pathname || candidate.name });
    title ||= pageTitle;
    description ||= $('meta[name="description"]').attr('content')?.trim() ?? '';
    $('a[href^="mailto:"]').each((_, node) => {
      const value = normalizeEmail($(node).attr('href')?.slice(7).split('?')[0]);
      if (value) { emails.add(value); addContactSource(contactSources, { kind: 'email', value, sourceType: 'company_website', sourceUrl: document.url }); }
    });
    $('a[href^="tel:"]').each((_, node) => {
      const value = normalizePhone($(node).attr('href')?.slice(4));
      if (value) { phones.add(value); addContactSource(contactSources, { kind: 'phone', value, sourceType: 'company_website', sourceUrl: document.url }); }
    });
    $('[data-email],[data-phone],[data-tel]').each((_, node) => {
      const email = normalizeEmail($(node).attr('data-email'));
      const phone = normalizePhone($(node).attr('data-phone') ?? $(node).attr('data-tel'));
      if (email) { emails.add(email); addContactSource(contactSources, { kind: 'email', value: email, sourceType: 'company_website', sourceUrl: document.url }); }
      if (phone) { phones.add(phone); addContactSource(contactSources, { kind: 'phone', value: phone, sourceType: 'company_website', sourceUrl: document.url }); }
    });
    $('a[href]').each((_, node) => {
      const href = $(node).attr('href') ?? '';
      if (/wa\.me\/|api\.whatsapp\.com\/send/i.test(href)) {
        const value = normalizePhone(href.match(/(?:phone=|wa\.me\/)(\+?\d{8,15})/i)?.[1]);
        if (value) { phones.add(value); addContactSource(contactSources, { kind: 'phone', value, sourceType: 'company_website', sourceUrl: document.url }); }
      }
      if (/linkedin|facebook|instagram|x\.com|twitter/i.test(href)) {
        try {
          const socialUrl = new URL(href, document.url).toString();
          socialLinks.add(socialUrl);
          addContactSource(contactSources, { kind: 'social', value: socialUrl, sourceType: 'company_website', sourceUrl: document.url });
        } catch { /* malformed social URL */ }
      }
      const label = $(node).text().replace(/\s+/g, ' ').trim();
      if (/service|product|solution|menu|pricing|shop/i.test(`${href} ${label}`) && label.length > 2 && label.length < 80) services.add(label);
    });
    $('form').each((_, node) => {
      const form = $(node);
      const formSignal = `${form.attr('id') ?? ''} ${form.attr('class') ?? ''} ${form.attr('action') ?? ''} ${form.text()}`.replace(/\s+/g, ' ').trim();
      if (form.find('input[type="email"],input[type="tel"],textarea').length && /contact|message|enquir|inquiry|email|phone|support|name/i.test(formSignal)) {
        addCapabilityHit(capabilityHits.contactForm, document.url, compactSignal(formSignal, 'Contact form with public reply fields'));
      }
      if (/book|booking|appointment|schedule|reservation|calendly/i.test(formSignal)) addCapabilityHit(capabilityHits.booking, document.url, compactSignal(formSignal, 'Booking form'));
      if (/checkout|cart|buy now|purchase|place order|order now/i.test(formSignal)) addCapabilityHit(capabilityHits.onlinePurchase, document.url, compactSignal(formSignal, 'Purchase form'));
    });
    $('a[href],button,[role="button"]').each((_, node) => {
      const control = $(node);
      const signal = `${control.attr('href') ?? ''} ${control.attr('aria-label') ?? ''} ${control.text()}`.replace(/\s+/g, ' ').trim();
      if (/\b(book now|book online|schedule (?:now|online|appointment)|make an appointment|reserve now)\b/i.test(signal) || /calendly\.com|cal\.com\/|booking\.com\/.*reserve/i.test(signal)) {
        addCapabilityHit(capabilityHits.booking, document.url, compactSignal(signal, 'Booking control'));
      }
      if (/\b(add to cart|buy now|checkout|purchase now|place order|order online|shop now)\b/i.test(signal) || /\/checkout(?:[/?#]|$)|\/cart(?:[/?#]|$)/i.test(signal)) {
        addCapabilityHit(capabilityHits.onlinePurchase, document.url, compactSignal(signal, 'Purchase control'));
      }
    });
    for (const value of extractEmails(text)) {
      emails.add(value); addContactSource(contactSources, { kind: 'email', value, sourceType: 'company_website', sourceUrl: document.url });
    }
    for (const value of extractPhones(text)) {
      phones.add(value); addContactSource(contactSources, { kind: 'phone', value, sourceType: 'company_website', sourceUrl: document.url });
    }
  }
  hasContactForm = capabilityHits.contactForm.evidence.size > 0;
  hasBooking = capabilityHits.booking.evidence.size > 0;
  hasPayment = capabilityHits.onlinePurchase.evidence.size > 0;
  const combined = texts.join(' ').slice(0, 24_000);
  return {
    title, description, about: combined.slice(0, 2_000), services: [...services].slice(0, 20),
    emails: [...emails].slice(0, 20), phones: [...phones].slice(0, 20),
    socialLinks: [...socialLinks].slice(0, 20), technologies: [],
    hasContactForm, hasBooking, hasPayment, pagesCrawled: documents.length, usedBrowser: false,
    textSample: combined.slice(0, 8_000), contactSources: [...contactSources.values()].slice(0, 60),
    capabilities: {
      contactForm: capabilitySignal(capabilityHits.contactForm, documents.length),
      booking: capabilitySignal(capabilityHits.booking, documents.length),
      onlinePurchase: capabilitySignal(capabilityHits.onlinePurchase, documents.length),
    },
    pages,
  };
}

function pagePriority(value: string) {
  if (/contact|reach-us|get-in-touch/i.test(value)) return 100;
  if (/booking|appointment|schedule|reserve|checkout|cart|order|shop|store/i.test(value)) return 90;
  if (/about|team|staff|leadership|founder/i.test(value)) return 75;
  if (/services?|products?|solutions?|menu|pricing|plans?/i.test(value)) return 65;
  if (/support|help|faq|locations?|branches/i.test(value)) return 50;
  return 0;
}

function sameHostname(left: URL, right: URL) {
  return left.hostname.replace(/^www\./i, '').toLowerCase() === right.hostname.replace(/^www\./i, '').toLowerCase();
}

function addCapabilityHit(target: { sourceUrls: Set<string>; evidence: Set<string> }, sourceUrl: string, evidence: string) {
  target.sourceUrls.add(sourceUrl);
  if (evidence) target.evidence.add(evidence.slice(0, 180));
}

function capabilitySignal(target: { sourceUrls: Set<string>; evidence: Set<string> }, pagesCrawled: number): CapabilitySignal {
  return {
    status: target.evidence.size ? 'detected' : pagesCrawled ? 'not_detected' : 'unknown',
    sourceUrls: [...target.sourceUrls].slice(0, 5), evidence: [...target.evidence].slice(0, 5),
  };
}

function demoCapability(detected: boolean, evidence: string): CapabilitySignal {
  return { status: detected ? 'detected' : 'not_detected', sourceUrls: [], evidence: detected ? [evidence] : [] };
}

function compactSignal(value: string, fallback: string) {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length >= 3 ? compact.slice(0, 180) : fallback;
}

function extractStructuredData(
  $: ReturnType<typeof load>, sourceUrl: string, emails: Set<string>, phones: Set<string>, socialLinks: Set<string>,
  contactSources: Map<string, ContactEvidenceSource>, services: Set<string>,
  capabilities: Record<'contactForm' | 'booking' | 'onlinePurchase', { sourceUrls: Set<string>; evidence: Set<string> }>,
) {
  $('script[type="application/ld+json"]').each((_, node) => {
    try {
      const parsed = JSON.parse($(node).text()) as unknown;
      const queue: unknown[] = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length) {
        const value = queue.shift();
        if (!value || typeof value !== 'object') continue;
        const record = value as Record<string, unknown>;
        if (Array.isArray(record['@graph'])) queue.push(...record['@graph']);
        for (const key of ['contactPoint','department','subOrganization','location','itemListElement','hasOfferCatalog']) {
          const nested = record[key];
          if (Array.isArray(nested)) queue.push(...nested);
          else if (nested && typeof nested === 'object') queue.push(nested);
        }
        const email = normalizeEmail(record.email);
        if (email) { emails.add(email); addContactSource(contactSources, { kind: 'email', value: email, sourceType: 'structured_data', sourceUrl }); }
        const phone = normalizePhone(record.telephone);
        if (phone) { phones.add(phone); addContactSource(contactSources, { kind: 'phone', value: phone, sourceType: 'structured_data', sourceUrl }); }
        const sameAs = Array.isArray(record.sameAs) ? record.sameAs : record.sameAs ? [record.sameAs] : [];
        for (const item of sameAs.map(String)) {
          if (!/^https?:\/\//i.test(item)) continue;
          socialLinks.add(item); addContactSource(contactSources, { kind: 'social', value: item, sourceType: 'structured_data', sourceUrl });
        }
        const types = (Array.isArray(record['@type']) ? record['@type'] : [record['@type']]).map(String);
        const name = typeof record.name === 'string' ? record.name.trim() : '';
        if (name && types.some((type) => /Product|Service|Offer|MenuItem/i.test(type))) services.add(name.slice(0, 80));
        const action = record.potentialAction && typeof record.potentialAction === 'object' ? record.potentialAction as Record<string, unknown> : undefined;
        const actionType = String(action?.['@type'] ?? '');
        if (/ReserveAction|ScheduleAction/i.test(actionType)) addCapabilityHit(capabilities.booking, sourceUrl, `${actionType} structured action`);
        if (/BuyAction|OrderAction/i.test(actionType)) addCapabilityHit(capabilities.onlinePurchase, sourceUrl, `${actionType} structured action`);
      }
    } catch { /* ignore invalid JSON-LD */ }
  });
}

export async function qualifyBusiness(candidate: BusinessCandidate, evidence?: Record<string, unknown>) {
  const pagesCrawled = Number(evidence?.pages_crawled ?? 0);
  const storedEvidence = evidence?.evidence && typeof evidence.evidence === 'object' ? evidence.evidence as Record<string, unknown> : {};
  const capabilities = storedEvidence.capabilities && typeof storedEvidence.capabilities === 'object' ? storedEvidence.capabilities : undefined;
  const scoring = calculateQualificationScore(candidate, {
    hasBooking: evidence?.has_booking === true,
    hasContactForm: evidence?.has_contact_form === true,
    hasPayment: evidence?.has_payment === true,
    pagesCrawled,
    publicEmails: Array.isArray(evidence?.emails) ? evidence.emails.length : 0,
    publicPhones: Array.isArray(evidence?.phones) ? evidence.phones.length : 0,
    socialProfiles: Array.isArray(evidence?.social_links) ? evidence.social_links.length : 0,
    crawlFailed: Boolean(storedEvidence.crawlError),
  });
  const qualifiedOpportunity = ['new_website', 'website_improvement'].includes(scoring.opportunity);
  const ruleResult = {
    qualified: qualifiedOpportunity && scoring.score >= config.MIN_QUALIFICATION_SCORE,
    score: scoring.score,
    opportunity: scoring.opportunity,
    painPoints: normalizePainPoints(scoring.painPoints, pagesCrawled),
    scoreBreakdown: scoring.breakdown,
    recommendedRole: 'Owner',
    rationale: buildQualificationRationale(candidate, evidence, scoring.painPoints),
    model: 'bayesian-weighted-rules',
  };
  if (config.PROVIDER_MODE === 'safe') return {
    ...ruleResult, rationale: 'Deterministic safe-mode qualification using stored evidence.', model: 'rules-safe-mode',
  };

  const schema = {
    type: 'object', required: ['recommended_role','rationale'],
    properties: {
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
    capabilities,
    publicEmailsFound: Array.isArray(evidence.emails) ? evidence.emails.length : 0,
    publicPhonesFound: Array.isArray(evidence.phones) ? evidence.phones.length : 0,
    socialProfilesFound: Array.isArray(evidence.social_links) ? evidence.social_links.length : 0,
    textSample: String(storedEvidence.textSample ?? '').slice(0, 1_800),
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
        options: { temperature: 0.1, num_ctx: 2048, num_predict: 192 }, messages: [
          { role: 'system', content: 'Explain the supplied algorithmic lead assessment; do not assign or alter its score, qualification, opportunity type, or pain points. Never invent facts. A detected capability may be stated as present. Not_detected means only that it was not seen on checked pages; never claim definite absence. Unknown means no conclusion is allowed. The rationale must explain why this is or is not an outreach priority in 1-3 concise sentences. Return strict JSON.' },
          { role: 'user', content: JSON.stringify({ company: compactCompany, websiteEvidence: compactEvidence, algorithmicAssessment: ruleResult }) },
        ] }),
    });
    if (!response.ok) throw new Error(`Ollama error ${response.status}`);
    const data = await response.json() as { message?: { content?: string } };
    const parsed = JSON.parse(data.message?.content ?? '{}') as Record<string, unknown>;
    const painPoints = ruleResult.painPoints;
    const aiRationale = String(parsed.rationale ?? '').trim();
    const rationale = aiRationale && rationaleMatchesEvidence(aiRationale, capabilities)
      ? aiRationale : buildQualificationRationale(candidate, evidence, painPoints);
    return {
      ...ruleResult,
      recommendedRole: String(parsed.recommended_role ?? 'Owner'), rationale, model: config.OLLAMA_MODEL,
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

  const socialPages = await Promise.allSettled([...socialLinks].slice(0, 6).map((url) => crawlPublicContactPage(url)));
  for (const result of socialPages) {
    if (result.status !== 'fulfilled') continue;
    for (const email of result.value.emails) {
      emails.add(email); addContactSource(sources, { kind: 'email', value: email, sourceType: 'social_profile', sourceUrl: result.value.url });
    }
    for (const phone of result.value.phones) {
      phones.add(phone); addContactSource(sources, { kind: 'phone', value: phone, sourceType: 'social_profile', sourceUrl: result.value.url });
    }
  }

  const domain = normalizeDomain(candidate.website);
  const location = [candidate.city, candidate.country].filter(Boolean).join(' ');
  const queries = [
    `${candidate.name} proprietor managing director partner president ${location}`,
    `site:linkedin.com/in ${candidate.name} owner founder CEO director`,
    `"${candidate.name}" email contact ${location}`,
    `"${candidate.name}" gmail phone ${location}`,
    `"${candidate.name}" owner founder director ${location}`,
    `"${candidate.name}" (site:linkedin.com OR site:facebook.com OR site:instagram.com) contact ${location}`,
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

async function crawlPublicContactPage(url: string) {
  if (!/^https?:\/\//i.test(url) || !/(?:linkedin|facebook|instagram|x\.com|twitter)\./i.test(url)) return { url, emails: [], phones: [] };
  const response = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; LeadForgePublicResearch/1.0)' },
    redirect: 'follow', signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) return { url, emails: [], phones: [] };
  const $ = load((await response.text()).slice(0, 500_000));
  $('script,style,noscript,svg').remove();
  const text = $('body').text().replace(/\s+/g, ' ').slice(0, 40_000);
  const mailto = $('a[href^="mailto:"]').map((_, node) => $(node).attr('href')?.slice(7).split('?')[0] ?? '').get();
  const telephone = $('a[href^="tel:"]').map((_, node) => $(node).attr('href')?.slice(4) ?? '').get();
  return { url: response.url || url, emails: extractEmails(`${text} ${mailto.join(' ')}`), phones: extractPhones(`${text} ${telephone.join(' ')}`) };
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

export async function findDecisionMakers(candidate: BusinessCandidate, role = 'Owner', suppliedResults: PublicSearchResult[] = []) {
  if (config.PROVIDER_MODE === 'safe') {
    const names = ['Aarav Sharma', 'Isha Patel', 'Rohan Das', 'Meera Singh', 'Arjun Rao'];
    return [{
      fullName: names[candidate.name.length % names.length]!, role, confidence: 76,
      ...(candidate.website ? { sourceUrl: candidate.website } : {}),
    }];
  }
  const contacts: Array<{ fullName: string; role: string; sourceUrl?: string; confidence: number }> = [];
  if (candidate.owner?.name) contacts.push({
    fullName: candidate.owner.name, role, confidence: 88,
    ...(candidate.owner.sourceUrl ? { sourceUrl: candidate.owner.sourceUrl } : {}),
  });
  const results = suppliedResults.length ? suppliedResults : await searchPublicWeb(
    `${candidate.name} owner founder CEO director proprietor partner ${candidate.city ?? ''}`,
  );
  const companyTokens = candidate.name.toLowerCase().split(/[^a-z0-9]+/).filter((value) => value.length >= 4);
  const domain = normalizeDomain(candidate.website);
  const rolePattern = /\b(co[ -]?founder|founder|owner|chief executive officer|ceo|managing director|director|proprietor|partner|president)\b/i;
  for (const result of results) {
    const combined = `${result.title ?? ''} ${result.content ?? ''}`;
    const roleMatch = combined.match(rolePattern);
    if (!roleMatch) continue;
    const relevant = companyTokens.some((token) => combined.toLowerCase().includes(token))
      || Boolean(domain && result.url?.toLowerCase().includes(domain));
    if (!relevant) continue;
    const titleParts = (result.title ?? '').split(/\s+(?:\||-|–|—|:)\s+/);
    const contentName = combined.match(/\b([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3})\s+(?:is\s+(?:the\s+)?|,\s*)?(?:co[ -]?founder|founder|owner|chief executive officer|ceo|managing director|director|proprietor|partner|president)\b/i)?.[1];
    const rawName = contentName ?? titleParts.find((part) => isLikelyPersonName(part, candidate.name, rolePattern));
    if (!rawName) continue;
    const fullName = rawName.replace(rolePattern, '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!isLikelyPersonName(fullName, candidate.name, rolePattern)) continue;
    contacts.push({
      fullName,
      role: titleCase(roleMatch[1]!.replace(/chief executive officer/i, 'CEO')),
      confidence: result.url && domain && result.url.toLowerCase().includes(domain) ? 82
        : result.url && /linkedin\.com\/in\//i.test(result.url) ? 76 : 64,
      ...(result.url ? { sourceUrl: result.url } : {}),
    });
  }
  const unique = new Map<string, (typeof contacts)[number]>();
  for (const contact of contacts) {
    const key = contact.fullName.toLowerCase();
    const previous = unique.get(key);
    if (!previous || contact.confidence > previous.confidence) unique.set(key, contact);
  }
  return [...unique.values()].sort((left, right) => right.confidence - left.confidence).slice(0, 5);
}

function isLikelyPersonName(value: string, companyName: string, rolePattern: RegExp) {
  const clean = value.replace(rolePattern, '').replace(/\s+/g, ' ').trim();
  const words = clean.split(' ').filter(Boolean);
  if (words.length < 2 || words.length > 5 || clean.length > 100) return false;
  if (!/^[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*)+$/.test(clean)) return false;
  if (clean.toLowerCase() === companyName.toLowerCase()) return false;
  return !/\b(company|business|official|profile|linkedin|facebook|instagram|services|solutions|private|limited|ltd)\b/i.test(clean);
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
    const raw = match[0];
    const context = value.slice(Math.max(0, (match.index ?? 0) - 28), (match.index ?? 0) + raw.length + 28);
    const bareDigits = /^\d{8,15}$/.test(raw.trim());
    if (bareDigits && !/phone|call|mobile|tel|contact|whats\s?app/i.test(context)) continue;
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
  const pagesCrawled = Number(evidence?.pages_crawled ?? 0);
  if (!candidate.website) signals.push('no business website was detected');
  else if (pagesCrawled === 0) signals.push('the website could not yet be evaluated from public pages');
  else if (evidence?.has_booking === false && painPoints.some((point) => /booking/i.test(point))) signals.push(`no online booking flow was detected on ${pagesCrawled} checked page${pagesCrawled === 1 ? '' : 's'}`);
  if (candidate.phone) signals.push('the business has a public contact number');
  if ((candidate.reviewCount ?? 0) >= 30) signals.push(`${candidate.reviewCount} Google reviews indicate an established active business`);
  if (pagesCrawled > 0 && evidence?.has_contact_form === false) signals.push('no contact form was detected on the checked pages');
  const observed = signals.slice(0, 3).join('; ') || 'the available public evidence is limited';
  return `Potential-client assessment: ${observed}. The clearest opportunity is ${painPoints[0]?.toLowerCase() ?? 'a review of the website conversion path'}.`;
}

function normalizePainPoints(values: string[], pagesCrawled: number) {
  const checkedPages = `on ${pagesCrawled} checked page${pagesCrawled === 1 ? '' : 's'}`;
  return [...new Set(values.map((value) => {
    if (pagesCrawled === 0 && /booking|payment|purchase|contact form|e-?commerce/i.test(value)) return 'Website capability could not be confirmed from public pages';
    if (/^(?:no|missing|lacks?)\b.*booking/i.test(value)) return `No online booking flow detected ${checkedPages}`;
    if (/^(?:no|missing|lacks?)\b.*contact form/i.test(value)) return `No contact form detected ${checkedPages}`;
    if (/^(?:no|missing|lacks?)\b.*(?:payment|purchase|checkout|e-?commerce)/i.test(value)) return `No online purchase or payment flow detected ${checkedPages}`;
    return value;
  }))];
}

function rationaleMatchesEvidence(value: string, capabilities: unknown) {
  const record = capabilities && typeof capabilities === 'object' ? capabilities as Record<string, unknown> : {};
  const status = (key: string) => {
    const signal = record[key];
    return signal && typeof signal === 'object' ? String((signal as Record<string, unknown>).status ?? 'unknown') : 'unknown';
  };
  const unsupportedPresence = (key: string, term: RegExp) => status(key) !== 'detected'
    && new RegExp(`\\b(?:has|offers?|supports?|provides?|includes?|allows?|features?)\\b.{0,55}${term.source}`, 'i').test(value);
  const unsupportedAbsence = (key: string, term: RegExp) => status(key) !== 'detected'
    && new RegExp(`\\b(?:lacks?|without|does not have|has no)\\b.{0,45}${term.source}`, 'i').test(value);
  return !unsupportedPresence('booking', /(?:online )?(?:booking|appointment|scheduling)/i)
    && !unsupportedPresence('onlinePurchase', /(?:online )?(?:purchase|checkout|payment|store|shop|e-?commerce)/i)
    && !unsupportedPresence('contactForm', /contact form/i)
    && !unsupportedAbsence('booking', /(?:booking|appointment|scheduling)/i)
    && !unsupportedAbsence('onlinePurchase', /(?:purchase|checkout|payment|store|shop|e-?commerce)/i)
    && !unsupportedAbsence('contactForm', /contact form/i);
}

function titleCase(value: string) { return value.replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function stringValue(value: unknown) { return value == null ? undefined : String(value); }
function numberValue(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined; }
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (character) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' })[character]!); }
function delay(milliseconds: number) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
