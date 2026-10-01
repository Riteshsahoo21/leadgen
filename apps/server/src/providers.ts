import fs from 'node:fs';
import dns from 'node:dns/promises';
import nodeDns from 'node:dns';
import { load } from 'cheerio';
import { parse } from 'csv-parse/sync';
import { CheerioCrawler, PlaywrightCrawler, Configuration, LogLevel, log as crawleeLog, gotScraping } from 'crawlee';
import { config } from './config.js';
import { calculateQualificationScore, normalizeDomain, type BusinessCandidate, type CreateRunInput } from './domain.js';

crawleeLog.setLevel(LogLevel.WARNING);

try {
  const currentServers = nodeDns.getServers();
  if (currentServers.length === 0 || (currentServers.length === 1 && currentServers[0] === '127.0.0.1')) {
    nodeDns.setServers(['1.1.1.1', '8.8.8.8']);
  }
} catch { /* ignore DNS server override error */ }

const globalMxCache = new Map<string, { mx: Awaited<ReturnType<typeof dns.resolveMx>> | undefined; timestamp: number }>();
const MX_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const sharedCrawleeConfig = new Configuration({
  persistStorage: false,
  purgeOnStart: true,
  memoryMbytes: 1536,
  availableMemoryRatio: 0.95,
});

const serviceWords = ['Studio', 'Works', 'Collective', 'Partners', 'Solutions', 'House', 'Company'];

export function safeBusinesses(input: CreateRunInput): BusinessCandidate[] {
  const combinations = input.cities.flatMap((city) => input.businessTypes.map((businessType) => ({ city, businessType })));
  const target = Math.min(input.maxDiscovery ?? input.targetCount, config.MAX_DISCOVERY_RESULTS);
  return Array.from({ length: target }, (_, index) => {
    const combination = combinations[index % combinations.length]!;
    const serial = index + 1;
    const slug = `${input.name}-${combination.businessType}-${combination.city}-${serial}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
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
  checkpoint?: {
    jobId?: string;
    keywords: string[];
    phase?: 'no_website' | 'website_improvement';
    saveJob: (id: string) => Promise<void>;
    onProgress?: (msg: string) => Promise<void>;
  },
): Promise<BusinessCandidate[]> {
  const phase = checkpoint?.phase ?? 'website_improvement';
  if (config.PROVIDER_MODE === 'safe') return safeBusinesses({ ...input, name: checkpoint?.keywords[0] ?? input.name });
  if (await shouldStop?.()) return [];

  const scrapePool = input.maxDiscovery ? Number(input.maxDiscovery) : Math.max(input.targetCount * 2, 50);
  const keywords = checkpoint?.keywords ?? (phase === 'no_website' ? buildNoWebsiteKeywords(input) : buildDiscoveryKeywords(input));
  const depth = mapsDepthFor(scrapePool, keywords.length, phase);
  let jobId = checkpoint?.jobId;
  if (!jobId) {
  const response = await fetch(`${config.GMAPS_API_URL}/api/v1/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: input.name,
      keywords,
      lang: 'en',
      depth,
      email: false,
      max_time: 120,
      max_results: Math.min(scrapePool, config.MAX_DISCOVERY_RESULTS),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Maps service rejected the job (${response.status}): ${await response.text()}`);
  const payload = await response.json() as Record<string, any>;
  const immediateResults = payload.results ?? payload.Results;
  if (Array.isArray(immediateResults)) return uniqueBusinessCandidates(immediateResults.map(mapMapsResult), scrapePool);
  jobId = String(payload.id ?? payload.ID ?? payload.job_id ?? payload.job?.id ?? '');
  if (!jobId) throw new Error('Maps service returned neither results nor a job ID');
  await checkpoint?.saveJob(jobId);
  }
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (await shouldStop?.()) return [];
    await delay(attempt === 0 ? 2_000 : 5_000);
    if (await shouldStop?.()) return [];
    if (attempt > 0 && attempt % 5 === 0 && checkpoint?.onProgress) {
      await checkpoint.onProgress(`Google Maps scraping in progress: batch job ${jobId.slice(0, 8)}... (poll attempt ${attempt + 1})`).catch(() => undefined);
    }
    let statusResponse: Response;
    try {
      statusResponse = await fetch(`${config.GMAPS_API_URL}/api/v1/jobs/${encodeURIComponent(jobId)}`, { signal: AbortSignal.timeout(120_000) });
    } catch (pollErr) {
      console.warn(`[discoverBusinesses] Status poll attempt ${attempt + 1} timed out or failed, will retry:`, pollErr instanceof Error ? pollErr.message : String(pollErr));
      continue;
    }
    if (!statusResponse.ok) {
      console.warn(`[discoverBusinesses] Status poll returned HTTP ${statusResponse.status}, will retry`);
      continue;
    }
    const statusPayload = await statusResponse.json() as Record<string, any>;
    const statusResults = statusPayload.results ?? statusPayload.Results;
    if (Array.isArray(statusResults)) return uniqueBusinessCandidates(statusResults.map(mapMapsResult), scrapePool);
    const status = String(statusPayload.status ?? statusPayload.Status ?? statusPayload.state ?? statusPayload.State ?? '').toLowerCase();
    if (['failed', 'error', 'cancelled'].includes(status)) throw new Error(`Maps job ${jobId} ${status}: ${statusPayload.error ?? ''}`);
    if (['completed', 'complete', 'done', 'success', 'succeeded', 'ok'].includes(status)) {
      let download: Response | undefined;
      for (let dlAttempt = 0; dlAttempt < 3; dlAttempt += 1) {
        try {
          download = await fetch(`${config.GMAPS_API_URL}/api/v1/jobs/${encodeURIComponent(jobId)}/download`, { signal: AbortSignal.timeout(60_000) });
          if (download.ok) break;
        } catch (dlErr) {
          console.warn(`[discoverBusinesses] Download attempt ${dlAttempt + 1} failed:`, dlErr instanceof Error ? dlErr.message : String(dlErr));
          await delay(3_000);
        }
      }
      if (!download || !download.ok) throw new Error(`Maps result download failed (${download?.status ?? 'network error'})`);
      const rows = parse(await download.text(), { columns: true, skip_empty_lines: true, relax_column_count: true }) as unknown[];
      return uniqueBusinessCandidates(rows.map(mapMapsResult), scrapePool);
    }
  }
  throw new Error(`Maps job ${jobId} did not complete within the polling window`);
}

export function mapsDepthFor(targetCount: number, keywordCount: number, phase: 'no_website' | 'website_improvement' = 'website_improvement') {
  const base = Math.ceil(targetCount / Math.max(keywordCount, 1) / 15);
  const minDepth = phase === 'no_website' ? 3 : 1;
  return Math.min(10, Math.max(minDepth, base));
}

export function buildNoWebsiteKeywords(input: CreateRunInput): string[] {
  const poolLimit = input.maxDiscovery ? Number(input.maxDiscovery) : Math.max(input.targetCount * 2, 50);
  const neededBatches = Math.max(
    input.cities.length * input.businessTypes.length * 6,
    Math.ceil(poolLimit / 12),
  );
  const desired = Math.min(300, Math.max(neededBatches, 10));

  const isDubai = input.cities.some((c) => /dubai/i.test(c)) || /emirates|uae/i.test(input.country);
  const industrialZones = isDubai ? [
    'Al Quoz Industrial Area 1', 'Al Quoz Industrial Area 2', 'Al Quoz Industrial Area 3', 'Al Quoz Industrial Area 4',
    'Al Qusais Industrial Area 1', 'Al Qusais Industrial Area 2', 'Al Qusais Industrial Area 3', 'Al Qusais Industrial Area 4', 'Al Qusais Industrial Area 5',
    'Ras Al Khor Industrial Area 1', 'Ras Al Khor Industrial Area 2', 'Ras Al Khor Industrial Area 3',
    'Jebel Ali Industrial Area 1', 'Umm Ramool', 'Deira wholesale', 'Al Khabisi', 'Al Garhoud industrial',
  ] : [
    'Industrial Area 1', 'Industrial Area 2', 'Industrial Area 3', 'Industrial Estate', 'Phase 1 Industrial',
    'Phase 2 Industrial', 'Warehouse District', 'Wholesale Market', 'Workshop Area', 'Old Town Market',
    'Industrial Zone', 'SME Cluster', 'Fabrication Zone', 'Sector 1 Industrial', 'Sector 2 Industrial',
  ];

  const unDigitizedModifiers = ['workshop', 'works', 'fabrication', 'repair', 'trading', 'services', 'small', 'local', 'unit'];
  const keywords: string[] = [];

  for (const city of input.cities) {
    for (const type of input.businessTypes) {
      const baseType = type.replace(/\b(?:company|companies|corporation|inc|llc|manufacturer|manufacturers)\b/gi, '').trim() || type;

      for (const zone of industrialZones) {
        keywords.push(`${baseType} workshop in ${zone}, ${input.country}`);
        keywords.push(`${baseType} in ${zone}, ${input.country}`);
        keywords.push(`${baseType} fabrication in ${zone}, ${input.country}`);
        keywords.push(`${baseType} trading in ${zone}, ${input.country}`);
        if (keywords.length >= desired) return keywords;
      }

      for (const mod of unDigitizedModifiers) {
        keywords.push(`${baseType} ${mod} in ${city}, ${input.country}`);
        keywords.push(`local ${baseType} ${mod} near ${city}, ${input.country}`);
        if (keywords.length >= desired) return keywords;
      }
    }
  }

  for (const city of input.cities) {
    for (const type of input.businessTypes) {
      keywords.push(`local ${type} in ${city}, ${input.country}`);
      keywords.push(`${type} near ${city}, ${input.country}`);
      if (keywords.length >= desired) return keywords;
    }
  }

  return keywords;
}

export function buildDiscoveryKeywords(input: CreateRunInput) {
  // Each Maps query has finite inventory. Expand large targets across geographic
  // sections and search intents, while keeping one bounded upstream job.
  const poolLimit = input.maxDiscovery ? Number(input.maxDiscovery) : Math.max(input.targetCount * 2, 50);
  const neededBatches = Math.max(
    input.cities.length * input.businessTypes.length * 6,
    Math.ceil(poolLimit / 12),
  );
  const desired = Math.min(300, Math.max(neededBatches, 5));

  const variants = [
    (type: string, city: string) => `${type} in ${city}, ${input.country}`,
    (type: string, city: string) => `${type} near ${city}, ${input.country}`,
    (type: string, city: string) => `best ${type} in ${city}, ${input.country}`,
    (type: string, city: string) => `top rated ${type} in ${city}, ${input.country}`,
    (type: string, city: string) => `local ${type} in ${city}, ${input.country}`,
    ...['central', 'north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest',
      'downtown', 'old town', 'suburbs', 'business district', 'industrial area', 'near airport', 'near railway station',
      'market', 'main road', 'city center', 'phase 1', 'phase 2']
      .map((area) => (type: string, city: string) => `${type} in ${area} ${city}, ${input.country}`),
  ];
  const keywords: string[] = [];
  for (const city of input.cities) for (const type of input.businessTypes) {
    if (!/\bconstruction\b/i.test(type)) continue;
    for (const specialty of ['construction companies', 'building contractors', 'civil contractors',
      'residential builders', 'construction contractors', 'home builders']) {
      keywords.push(`${specialty} in ${city}, ${input.country}`);
    }
  }
  for (const variant of variants) {
    for (const city of input.cities) {
      for (const type of input.businessTypes) {
        keywords.push(variant(type, city));
        if (keywords.length >= desired) return keywords;
      }
    }
  }
  // A single city and category still needs enough independent searches to
  // reach a qualified target larger than the first few Maps result pages.
  const areaTerms = ['central', 'north', 'south', 'east', 'west', 'downtown', 'old town',
    'suburbs', 'business district', 'industrial area', 'market', 'city center'];
  for (const area of areaTerms) {
    for (const intent of ['best', 'top rated', 'local', 'nearby', 'trusted', 'affordable']) {
      for (const city of input.cities) for (const type of input.businessTypes) {
        const keyword = `${intent} ${type} in ${area} ${city}, ${input.country}`;
        if (!keywords.includes(keyword)) keywords.push(keyword);
        if (keywords.length >= desired) return keywords;
      }
    }
  }
  return keywords;
}

function uniqueBusinessCandidates(candidates: BusinessCandidate[], limit: number) {
  const seen = new Set<string>();
  const unique: BusinessCandidate[] = [];
  for (const candidate of candidates) {
    const key = candidate.sourceId ? `place:${candidate.sourceId}`
      : normalizeDomain(candidate.website) ? `domain:${normalizeDomain(candidate.website)}`
        : candidate.phone ? `phone:${candidate.phone.replace(/\D/g, '')}`
          : `name:${candidate.name.toLowerCase()}|${candidate.address?.toLowerCase() ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key); unique.push(candidate);
    if (unique.length >= limit) break;
  }
  return unique;
}

function mapMapsResult(item: unknown): BusinessCandidate {
  const row = item as Record<string, unknown>;
  const owner = parseOwner(row.owner);
  const emails = [
    ...parseStringList(row.emails),
    ...parseStringList(row.email),
    ...parseStringList(row.Email),
    ...parseStringList(row.Emails),
  ];
  return {
    sourceId: stringValue(row.place_id ?? row.cid),
    name: stringValue(row.title ?? row.name) || 'Unknown business',
    category: stringValue(row.category),
    categories: Array.isArray(row.categories) ? row.categories.map(String) : [],
    country: stringValue(row.country) ?? '', city: stringValue(row.city), address: stringValue(row.address),
    phone: stringValue(row.phone), website: stringValue(row.web_site ?? row.website),
    rating: numberValue(row.review_rating ?? row.rating), reviewCount: numberValue(row.reviews ?? row.review_count),
    latitude: numberValue(row.latitude), longitude: numberValue(row.longitude),
    publicEmails: [...new Set(emails.map((e) => e.trim().toLowerCase().replace(/^mailto:/, '').split('?')[0]).filter((e): e is string => Boolean(e)))], owner, raw: row,
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
  hasViewport?: boolean; hasSsl?: boolean; isOutdated?: boolean; isModernPresence?: boolean; crawlBlocked?: boolean; siteIdentityMismatch?: boolean;
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
      hasViewport: true, hasSsl: true, isOutdated: false, isModernPresence: seed % 4 === 0,
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
  const documents: Array<{ url: string; html: string }> = [];
  const runCheerioCrawl = async (startUrl: string) => {
    const crawler = new CheerioCrawler({
      maxRequestsPerCrawl: config.MAX_PAGES_PER_SITE,
      maxConcurrency: 3,
      navigationTimeoutSecs: 10,
      requestHandlerTimeoutSecs: 10,
      maxRequestRetries: 0,
      async requestHandler({ $, request, enqueueLinks }) {
        const html = $.html().slice(0, 500_000);
        const finalUrl = request.loadedUrl || request.url;
        documents.push({ url: finalUrl, html });

        const hasEmail = documents.some(d => /mailto:|[\w.-]+@[\w.-]+\.[a-z]{2,}/i.test(d.html));
        const hasForm = documents.some(d => /<form/i.test(d.html) && /contact|enquir|message|quote|rfq|email|phone/i.test(d.html));

        // Early-exit optimization: if we have 2+ pages and already found both an email
        // and an enquiry/contact form, we have sufficient actionable evidence.
        if (documents.length >= 2 && hasEmail && hasForm) {
          return;
        }

        if (documents.length < 5) {
          await enqueueLinks({
            strategy: 'same-domain',
            transformRequestFunction(req) {
              try {
                const u = new URL(req.url);
                u.hash = '';
                u.search = '';
                if (/\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|tar|gz|mp4|mp3|avi|png|jpe?g|gif|webp|svg|ico|css|js|woff2?|xml|json|txt)$/i.test(u.pathname)) {
                  return false;
                }
                req.url = u.toString();
                const priority = pagePriority(req.url);
                req.userData = { priority };
                if (priority >= 60) {
                  (req as any).forefront = true;
                }
                return req;
              } catch {
                return false;
              }
            },
          });
        }
      },
      async failedRequestHandler({ request }, error) {
        // Individual subpage failures should not abort the site crawl
      },
    }, sharedCrawleeConfig);

    await crawler.run([startUrl]);
  };

  try {
    await runCheerioCrawl(root.toString());
  } catch { /* initial https crawl attempt failed */ }

  if (documents.length === 0 && root.protocol === 'https:') {
    const fallback = new URL(root);
    fallback.protocol = 'http:';
    try {
      await runCheerioCrawl(fallback.toString());
    } catch { /* fallback http crawl attempt failed */ }
  }

  let evidence = documents.length ? extractEvidence(documents, candidate) : undefined;
  const hasBotProtection = evidence?.crawlBlocked === true;
  const looksLikeJavascriptShell = documents.length > 0 &&
    documents.some(({ html }) => /<script[^>]+(?:src=|type=['"']module)/i.test(html)) &&
    (!evidence || evidence.textSample.length < 120);

  if (!hasBotProtection && looksLikeJavascriptShell) {
    try {
      const rendered = await renderWithPlaywright(root.toString(), sharedCrawleeConfig);
      if (rendered) {
        const merged = [...documents.slice(1), { url: root.toString(), html: rendered }];
        evidence = extractEvidence(merged, candidate);
        evidence.usedBrowser = true;
      }
    } catch (error) {
      if (!evidence) throw error;
    }
  }

  if (!evidence) {
    throw new Error('Website could not be reached, returned an empty response, or blocked automated crawling');
  }
  return evidence;
}

async function renderWithPlaywright(url: string, crawleeConfig: Configuration): Promise<string> {
  let rendered = '';
  const launchOptions: Record<string, unknown> = {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  };
  if (config.CHROMIUM_PATH && fs.existsSync(config.CHROMIUM_PATH)) {
    launchOptions.executablePath = config.CHROMIUM_PATH;
  }
  const crawler = new PlaywrightCrawler({
    maxRequestsPerCrawl: 1,
    requestHandlerTimeoutSecs: 20,
    maxRequestRetries: 0,
    launchContext: { launchOptions },
    async requestHandler({ page }) {
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(1000);
      rendered = (await page.content()).slice(0, 1_000_000);
    },
  }, crawleeConfig);

  await crawler.run([url]);
  return rendered;
}

function decodeCfEmail(encoded: string): string | undefined {
  if (!encoded || encoded.length < 4) return undefined;
  try {
    const k = parseInt(encoded.substring(0, 2), 16);
    let email = '';
    for (let n = 2; n < encoded.length; n += 2) {
      email += String.fromCharCode(parseInt(encoded.substring(n, n + 2), 16) ^ k);
    }
    return normalizeEmail(email);
  } catch {
    return undefined;
  }
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
    $('[data-cfemail]').each((_, node) => {
      const decoded = decodeCfEmail($(node).attr('data-cfemail') ?? '');
      if (decoded) { emails.add(decoded); addContactSource(contactSources, { kind: 'email', value: decoded, sourceType: 'company_website', sourceUrl: document.url }); }
    });
    $('a[href*="/cdn-cgi/l/email-protection"]').each((_, node) => {
      const href = $(node).attr('href') ?? '';
      const hash = href.split('#')[1] || href.split('email-protection/')[1];
      if (hash) {
        const decoded = decodeCfEmail(hash);
        if (decoded) { emails.add(decoded); addContactSource(contactSources, { kind: 'email', value: decoded, sourceType: 'company_website', sourceUrl: document.url }); }
      }
    });
    extractStructuredData($, document.url, emails, phones, socialLinks, contactSources, services, capabilityHits);
    $('script,style,noscript,svg').remove();
    $('br,p,div,li,td,th,h1,h2,h3,h4,h5,h6,section,article,a,span').after(' ');
    const text = $('body').text().replace(/\s+/g, ' ').trim();
    texts.push(text.slice(0, 12_000));
    const pageTitle = $('title').first().text().replace(/\s+/g, ' ').trim();
    pages.push({ url: document.url, title: pageTitle || new URL(document.url).pathname || candidate.name });
    title ||= pageTitle;
    description ||= $('meta[name="description"]').attr('content')?.trim() ?? '';
    $('a[href]').each((_, node) => {
      const href = $(node).attr('href')?.trim() ?? '';
      if (/^mailto:/i.test(href)) {
        try {
          const raw = decodeURIComponent(href.replace(/^mailto:/i, '').split('?')[0] ?? '').trim();
          const value = normalizeEmail(raw);
          if (value) { emails.add(value); addContactSource(contactSources, { kind: 'email', value, sourceType: 'company_website', sourceUrl: document.url }); }
        } catch { /* malformed mailto */ }
      }
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
      if (/book|booking|appointment|schedule|reservation|reserve|consult|calendly/i.test(formSignal)) addCapabilityHit(capabilityHits.booking, document.url, compactSignal(formSignal, 'Booking form'));
      if (/checkout|cart|basket|buy now|purchase|place order|order now|shop/i.test(formSignal)) addCapabilityHit(capabilityHits.onlinePurchase, document.url, compactSignal(formSignal, 'Purchase form'));
    });
    $('a[href],button,[role="button"]').each((_, node) => {
      const control = $(node);
      const signal = `${control.attr('href') ?? ''} ${control.attr('aria-label') ?? ''} ${control.text()}`.replace(/\s+/g, ' ').trim();
      if (
        /\b(book\s+(?:now|online|consultation|appointment|visit|table|service|demo)|schedule\s+(?:now|online|appointment|visit)|make\s+an?\s+appointment|reserve\s+(?:now|online|table)|request\s+(?:appointment|booking|consultation|quote)|enquire\s+now|get\s+a?\s+quote)\b/i.test(signal) ||
        /calendly\.com|cal\.com\/|booking\.com|fresha\.com|treatwell|phorest|timely|acuityscheduling|setmore|mindbody|simplybook|cliniko|zocdoc|opentable|resy|appointlet|jane\.app|vagaro|10to8\.com/i.test(signal)
      ) {
        addCapabilityHit(capabilityHits.booking, document.url, compactSignal(signal, 'Booking control'));
      }
      if (
        /\b(add to (?:cart|basket|quote)|buy now|checkout|purchase|place order|order online|shop now|view (?:cart|basket)|request price)\b/i.test(signal) ||
        /\/checkout(?:[/?#]|$)|\/cart(?:[/?#]|$)|\/basket(?:[/?#]|$)/i.test(signal) ||
        /shopify\.com|woocommerce|stripe\.com|snipcart|bigcommerce|paypal\.com\/checkout/i.test(signal)
      ) {
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
  const rawHtmlCombined = documents.map((d) => d.html).join(' ');
  const detectedTech = new Set<string>();
  if (/__next|_next\/static/i.test(rawHtmlCombined)) detectedTech.add('Next.js');
  if (/__nuxt|_nuxt\//i.test(rawHtmlCombined)) detectedTech.add('Nuxt');
  if (/webflow\.com|data-wf-page/i.test(rawHtmlCombined)) detectedTech.add('Webflow');
  if (/cdn\.shopify\.com|Shopify\.theme/i.test(rawHtmlCombined)) detectedTech.add('Shopify');
  if (/static1\.squarespace\.com/i.test(rawHtmlCombined)) detectedTech.add('Squarespace');
  if (/wixstatic\.com/i.test(rawHtmlCombined)) detectedTech.add('Wix');
  if (/elementor-kit|wp-content/i.test(rawHtmlCombined)) detectedTech.add('WordPress');
  if (/tailwind/i.test(rawHtmlCombined)) detectedTech.add('Tailwind');

  const isProtectedOrCloudflare = documents.some((d) =>
    /<title>\s*(?:Just a moment\.\.\.|Attention Required!\s*\|\s*Cloudflare|Security Challenge)\s*<\/title>|challenges\.cloudflare\.com|__cf_chl_|cf-browser-verification|cf-turnstile|cf_chl_opt|DDoS-GUARD/i.test(d.html)
  );
  if (isProtectedOrCloudflare) {
    detectedTech.add('Cloudflare');
    // A challenge page gives no evidence of conversion flows.
  }

  const siteIdentityMismatch = !isProtectedOrCloudflare && websiteIdentityMismatch(candidate, title, description, combined);
  const hasViewport = documents.some((d) => /<meta[^>]+name=["']viewport["']/i.test(d.html));
  const hasSsl = documents.some((d) => d.url.startsWith('https://'));
  const currentYear = new Date().getFullYear();
  const copyrightMatch = rawHtmlCombined.match(/©|&copy;|copyright\s*(?:20\d\d[-–])?(20\d\d)/i);
  const copyrightYear = copyrightMatch ? Number(copyrightMatch[1]) : undefined;
  const isOutdated = !isProtectedOrCloudflare && ((copyrightYear != null && copyrightYear <= currentYear - 4) ||
    /<frameset|<marquee|<font[\s>]/i.test(rawHtmlCombined));

  const isModernPresence = !isProtectedOrCloudflare && hasSsl && hasViewport && !isOutdated &&
    documents.length >= 2 && hasContactForm && (hasBooking || hasPayment);

  return {
    title, description, about: combined.slice(0, 2_000), services: [...services].slice(0, 20),
    emails: [...emails].slice(0, 20), phones: [...phones].slice(0, 20),
    socialLinks: [...socialLinks].slice(0, 20), technologies: [...detectedTech],
    hasContactForm, hasBooking, hasPayment, pagesCrawled: documents.length, usedBrowser: false,
    hasViewport, hasSsl, isOutdated, isModernPresence, crawlBlocked: isProtectedOrCloudflare, siteIdentityMismatch,
    textSample: combined.slice(0, 8_000), contactSources: [...contactSources.values()].slice(0, 60),
    capabilities: {
      contactForm: capabilitySignal(capabilityHits.contactForm, documents.length),
      booking: capabilitySignal(capabilityHits.booking, documents.length),
      onlinePurchase: capabilitySignal(capabilityHits.onlinePurchase, documents.length),
    },
    pages,
  };
}

export function websiteIdentityMismatch(candidate: BusinessCandidate, title: string, description: string, about: string) {
  const generic = new Set(['the', 'and', 'pvt', 'private', 'ltd', 'limited', 'llp', 'inc',
    'company', 'group', 'services', 'service', 'construction', 'constructions', 'builder',
    'builders', 'engineering', 'engineers', 'infra', 'infrastructure', 'projects', 'shree',
    'shri', 'sri', 'enterprises', 'solutions']);
  const tokens = candidate.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter((token) => token.length >= 3 && !generic.has(token));
  if (!tokens.length) return false;
  const site = `${normalizeDomain(candidate.website)} ${title} ${description} ${about.slice(0, 600)}`
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const words = new Set(site.split(' '));
  const hostname = normalizeDomain(candidate.website)?.replace(/[^a-z0-9]/g, '') ?? '';
  return !tokens.some((token) => words.has(token) || hostname.includes(token));
}

function pagePriority(value: string) {
  if (/contact|reach-us|get-in-touch|enquiry|inquiry|quote|rfq/i.test(value)) return 100;
  if (/booking|appointment|schedule|reserve|checkout|cart|basket|order|shop|store/i.test(value)) return 90;
  if (/about|team|staff|leadership|founder|who-we-are|profile|history/i.test(value)) return 75;
  if (/services?|products?|solutions?|manufacturing|factory|plant|capabilities|infrastructure|projects|menu|pricing|plans?/i.test(value)) return 65;
  if (/privacy|terms|legal|impressum|imprint|policy/i.test(value)) return 60;
  if (/support|help|faq|locations?|branches|distributors/i.test(value)) return 50;
  return 10;
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

export async function qualifyBusiness(candidate: BusinessCandidate, evidence?: Record<string, unknown>, includeAi = true) {
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
    crawlBlocked: storedEvidence.crawlBlocked === true,
    siteIdentityMismatch: storedEvidence.siteIdentityMismatch === true,
    crawlError: storedEvidence.crawlError ? String(storedEvidence.crawlError) : undefined,
    hasViewport: storedEvidence.hasViewport !== false,
    hasSsl: storedEvidence.hasSsl !== false,
    isOutdated: storedEvidence.isOutdated === true,
    isModernPresence: storedEvidence.isModernPresence === true,
    technologies: Array.isArray(storedEvidence.technologies) ? storedEvidence.technologies : [],
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
  if (!includeAi) return ruleResult;

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
    `"${candidate.name}" email contact ${location}`,
    `"${candidate.name}" owner founder director ${location}`,
    `site:linkedin.com/in "${candidate.name}"`,
    ...(domain ? [`site:${domain} email contact`] : [`"${candidate.name}" (directory OR facebook OR yellowpages) ${location}`]),
  ];
  const searchResults: PublicSearchResult[] = (await Promise.all(queries.map(searchPublicWeb))).flat()
    .filter((result) => searchResultMatchesBusiness(result, candidate));
  const urlsToCrawl: string[] = [];
  for (const result of searchResults) {
    const sourceUrl = result.url;
    if (sourceUrl && /\.(?:pdf|docx?|xlsx?)(?:[?#]|$)/i.test(sourceUrl)) continue;
    const text = deobfuscateContactText(`${result.title ?? ''} ${result.content ?? ''} ${sourceUrl ?? ''}`);
    const isSocial = Boolean(sourceUrl && /(?:linkedin|facebook|instagram|x\.com|twitter)\./i.test(sourceUrl));
    const sourceType = isSocial ? 'social_profile' : 'directory_listing';
    if (sourceUrl && isSocial) {
      socialLinks.add(sourceUrl);
      addContactSource(sources, { kind: 'social', value: sourceUrl, sourceType: 'social_profile', sourceUrl });
    }
    for (const email of extractEmails(text)) {
      emails.add(email);
      addContactSource(sources, { kind: 'email', value: email, sourceType, ...(sourceUrl ? { sourceUrl } : {}) });
    }
    for (const phone of extractPhones(text)) {
      phones.add(phone);
      addContactSource(sources, { kind: 'phone', value: phone, sourceType, ...(sourceUrl ? { sourceUrl } : {}) });
    }
    if (sourceUrl && /^https?:\/\//i.test(sourceUrl)
      && !/(?:google|bing|yahoo|duckduckgo|searx|yandex|baidu)\./i.test(sourceUrl)
      && !/\.(?:pdf|docx?|xlsx?|pptx?|zip|png|jpe?g)$/i.test(sourceUrl)
      && (!domain || !sourceUrl.toLowerCase().includes(domain))
      && !urlsToCrawl.includes(sourceUrl)
      && urlsToCrawl.length < 5) {
      urlsToCrawl.push(sourceUrl);
    }
  }

  if (urlsToCrawl.length > 0) {
    const crawledPages = await Promise.allSettled(urlsToCrawl.map((url) => crawlPublicContactPage(url)));
    for (const res of crawledPages) {
      if (res.status !== 'fulfilled') continue;
      const page = res.value;
      const isSocial = /(?:linkedin|facebook|instagram|x\.com|twitter)\./i.test(page.url);
      const pageSourceType = isSocial ? 'social_profile' : 'directory_listing';
      for (const email of page.emails) {
        emails.add(email);
        addContactSource(sources, { kind: 'email', value: email, sourceType: pageSourceType, sourceUrl: page.url });
      }
      for (const phone of page.phones) {
        phones.add(phone);
        addContactSource(sources, { kind: 'phone', value: phone, sourceType: pageSourceType, sourceUrl: page.url });
      }
    }
  }

  return {
    emails: [...emails].slice(0, 30), phones: [...phones].slice(0, 30), socialLinks: [...socialLinks].slice(0, 30),
    sources: [...sources.values()].slice(0, 100), searchResults: searchResults.slice(0, 60),
  };
}

async function crawlPublicContactPage(url: string) {
  if (!/^https?:\/\//i.test(url)) return { url, emails: [], phones: [] };
  if (/(?:google|bing|yahoo|duckduckgo|searx|yandex|baidu)\./i.test(url)) return { url, emails: [], phones: [] };
  if (/\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|tar|gz|mp4|mp3|avi|png|jpe?g|gif|webp|svg)$/i.test(url)) return { url, emails: [], phones: [] };
  try {
    const response = await gotScraping({
      url,
      timeout: { request: 10_000 },
      responseType: 'text',
      retry: { limit: 0 },
    });
    const contentType = String(response.headers['content-type'] ?? '');
    if (!contentType.includes('text/html')) return { url, emails: [], phones: [] };
    const $ = load((response.body as string).slice(0, 500_000));
    $('script,style,noscript,svg').remove();
    $('br,p,div,li,td,th,h1,h2,h3,h4,h5,h6,section,article,a,span').after(' ');
    const text = $('body').text().replace(/\s+/g, ' ').slice(0, 40_000);
    const mailto = $('a[href^="mailto:"]').map((_, node) => $(node).attr('href')?.slice(7).split('?')[0] ?? '').get();
    const telephone = $('a[href^="tel:"]').map((_, node) => $(node).attr('href')?.slice(4) ?? '').get();
    return { url: response.url || url, emails: extractEmails(`${text} ${mailto.join(' ')}`), phones: extractPhones(`${text} ${telephone.join(' ')}`) };
  } catch {
    return { url, emails: [], phones: [] };
  }
}

export async function findDecisionMaker(candidate: BusinessCandidate, role = 'Owner', suppliedResults: PublicSearchResult[] = []) {
  if (config.PROVIDER_MODE === 'safe') {
    const names = ['Aarav Sharma', 'Isha Patel', 'Rohan Das', 'Meera Singh', 'Arjun Rao'];
    return { fullName: names[candidate.name.length % names.length]!, role, sourceUrl: candidate.website, confidence: 76 };
  }
  if (candidate.owner?.name && isLikelyPersonName(candidate.owner.name, candidate.name, /owner/i)) {
    return { fullName: candidate.owner.name, role, sourceUrl: candidate.owner.sourceUrl, confidence: 82 };
  }
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
  const rolePattern = /\b(co[ -]?founder|founder|owner|chief executive officer|ceo|managing director|director|proprietor|partner|president)\b/i;
  if (candidate.owner?.name && isLikelyPersonName(candidate.owner.name, candidate.name, rolePattern)) {
    contacts.push({
      fullName: candidate.owner.name, role, confidence: 88,
      ...(candidate.owner.sourceUrl ? { sourceUrl: candidate.owner.sourceUrl } : {}),
    });
  }
  const results = suppliedResults.length ? suppliedResults : await searchPublicWeb(
    `"${candidate.name}" owner founder CEO director proprietor partner ${candidate.city ?? ''}`,
  );
  const companyTokens = candidate.name.toLowerCase().split(/[^a-z0-9]+/).filter((value) => value.length >= 3 && !['pty','ltd','the','and'].includes(value));
  const domain = normalizeDomain(candidate.website);
  const beforePattern = /\b(?:co[ -]?founder|founder|owner|chief executive officer|ceo|managing director|director|proprietor|partner|president)\s*(?::|–|-|is|at|of|\b)\s*([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3})\b/i;
  const afterPattern = /\b([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3})\s*(?:,|is\s+(?:the\s+)?|\s+is\s+)?\s*(?:co[ -]?founder|founder|owner|chief executive officer|ceo|managing director|director|proprietor|partner|president)\b/i;
  for (const result of results) {
    const combined = `${result.title ?? ''} ${result.content ?? ''}`;
    const roleMatch = combined.match(rolePattern);
    if (!roleMatch) continue;
    const relevant = companyTokens.some((token) => combined.toLowerCase().includes(token))
      || Boolean(domain && result.url?.toLowerCase().includes(domain));
    if (!relevant) continue;
    const titleParts = (result.title ?? '').split(/\s+(?:\||-|–|—|:)\s+/);
    const titleName = titleParts.find((part) => isLikelyPersonName(part, candidate.name, rolePattern));
    const extractedContentName = combined.match(afterPattern)?.[1]
      ?? combined.match(beforePattern)?.[1]
      ?? combined.match(/\b(?:officer|officers|director|directors|leadership)\s*:\s*([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3})\b/i)?.[1];
    const validContentName = extractedContentName && isLikelyPersonName(extractedContentName, candidate.name, rolePattern) ? extractedContentName : undefined;
    const rawName = titleName ?? validContentName;
    if (!rawName) continue;
    let fullName = rawName.replace(rolePattern, '').replace(/\s+/g, ' ').trim().slice(0, 100);
    fullName = fullName.replace(/^(?:at|of|the|for|and|in|from)\s+/i, '').trim();
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
  let clean = value.replace(rolePattern, '').replace(/\s+/g, ' ').trim();
  clean = clean.replace(/^(?:at|of|the|for|and|in|from)\s+/i, '').trim();
  const words = clean.split(' ').filter(Boolean);
  if (words.length < 2 || words.length > 4 || clean.length > 70) return false;
  if (!/^[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*)+$/.test(clean)) return false;
  if (clean.toLowerCase() === companyName.toLowerCase()) return false;
  const companyTokens = companyName.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !['pty','ltd','the','and','for'].includes(t));
  if (companyTokens.some((t) => clean.toLowerCase().includes(t))) return false;
  return !/\b(company|business|official|profile|linkedin|facebook|instagram|services|solutions|private|limited|ltd|llc|inc|corp|co|equipment|machinery|trading|factory|industries|industry|products|manufacturer|group|enterprise|enterprises)\b/i.test(clean);
}

export function searchResultMatchesBusiness(result: PublicSearchResult, candidate: BusinessCandidate) {
  const sourceDomain = normalizeDomain(result.url);
  const businessDomain = normalizeDomain(candidate.website);
  if (sourceDomain && businessDomain && sourceDomain === businessDomain) return true;
  const haystack = `${result.title ?? ''} ${result.url ?? ''}`.toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
  const compact = haystack.replace(/\s+/g, '');
  const fullName = candidate.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (fullName.length >= 6 && compact.includes(fullName)) return true;
  const generic = new Set(['private','limited','construction','constructions','builders','builder',
    'engineering','engineers','services','service','company','pvt','ltd','the','and','homes','home']);
  const distinctive = candidate.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter((word) => word.length >= 3 && !generic.has(word));
  const words = new Set(haystack.split(' '));
  return distinctive.length > 0 &&
    distinctive.filter((word) => words.has(word) || sourceDomain?.includes(word)).length >= Math.min(2, distinctive.length);
}

export async function enrichEmails(candidate: BusinessCandidate, fullName: string, publicSources: ContactEvidenceSource[] = [], harvested: string[] = []) {
  let domain = normalizeDomain(candidate.website);
  if (!domain) {
    for (const source of publicSources) {
      const emailDomain = source.value.split('@')[1]?.toLowerCase();
      if (emailDomain && !/(?:gmail|yahoo|hotmail|outlook|telkomsa|mweb|vodamail|icloud|aol|proton|zoho)\./i.test(emailDomain)) {
        domain = emailDomain;
        break;
      }
    }
  }
  const candidates = new Map<string, ContactEvidenceSource>();
  for (const source of publicSources.filter((item) => item.kind === 'email' &&
    (!['directory_listing','social_profile'].includes(item.sourceType) ||
      (item.sourceUrl && searchResultMatchesBusiness({ url: item.sourceUrl }, candidate))))) {
    const address = normalizeEmail(source.value);
    if (address) candidates.set(address, { ...source, value: address });
  }
  for (const address of [...(candidate.publicEmails ?? []), ...(publicSources.length ? [] : harvested)]) {
    const normalized = normalizeEmail(address);
    if (normalized && !candidates.has(normalized)) candidates.set(normalized, {
      kind: 'email', value: normalized, sourceType: candidate.publicEmails?.includes(address) ? 'google_maps' : 'company_website',
      ...(candidate.website ? { sourceUrl: candidate.website } : {}),
    });
  }
  if (domain && !/(?:gmail|yahoo|hotmail|outlook|proton|zoho)\./i.test(domain)) {
    const tokens = fullName.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
    const first = tokens[0];
    const last = tokens.at(-1);
    const patterns: string[] = [];
    if (first && last && first !== last && tokens.length >= 2) {
      patterns.push(`${first}.${last}@${domain}`);
      patterns.push(`${first}@${domain}`);
      patterns.push(`${first[0]}${last}@${domain}`);
    } else if (first && first.length >= 2) {
      patterns.push(`${first}@${domain}`);
    }
    patterns.push(`info@${domain}`);
    patterns.push(`contact@${domain}`);
    for (const pat of patterns) {
      const normalized = normalizeEmail(pat);
      if (normalized && !candidates.has(normalized)) {
        candidates.set(normalized, {
          kind: 'email',
          value: normalized,
          sourceType: 'generated_pattern',
          ...(candidate.website ? { sourceUrl: candidate.website } : {}),
        });
      }
    }
  }
  const results: Array<{ address: string; status: string; method: string; confidence: number; evidence: Record<string, unknown> }> = [];
  for (const source of [...candidates.values()].slice(0, 12)) {
    const address = source.value;
    const addressDomain = address.split('@')[1]?.toLowerCase();
    if (!addressDomain) continue;
    const isGenericWebmail = /(?:gmail|yahoo|hotmail|outlook|telkomsa|telkom|mweb|vodamail|icloud|aol|proton|zoho)\./i.test(addressDomain);
    if (domain && addressDomain !== domain && !isGenericWebmail) {
      continue;
    }
    if (config.PROVIDER_MODE === 'safe') {
      results.push({ address, status: 'valid', method: 'safe_mode', confidence: 90, evidence: { ...source, public: true } });
      continue;
    }
    try {
      const cached = globalMxCache.get(addressDomain);
      let mx: Awaited<ReturnType<typeof dns.resolveMx>> | undefined;
      if (cached && Date.now() - cached.timestamp < MX_CACHE_TTL_MS) {
        mx = cached.mx;
      } else {
        try {
          mx = await dns.resolveMx(addressDomain);
          globalMxCache.set(addressDomain, { mx, timestamp: Date.now() });
        } catch {
          globalMxCache.set(addressDomain, { mx: undefined, timestamp: Date.now() });
          mx = undefined;
        }
      }
      if (!mx?.length) {
        results.push({ address, status: 'invalid', method: 'dns_mx', confidence: 95, evidence: { ...source, reason: 'No MX records' } });
        continue;
      }
      const isHarvested = ['company_website', 'google_maps', 'structured_data', 'directory_listing', 'public_search', 'social_profile'].includes(source.sourceType);
      const generated = source.sourceType === 'generated_pattern';
      results.push({
        address, status: isHarvested ? 'valid' : 'risky',
        method: generated ? 'pattern_and_mx' : `${source.sourceType}_and_mx`,
        confidence: isHarvested ? 92 : 65,
        evidence: { ...source, public: !generated, mx: mx.map((entry) => entry.exchange) },
      });
    } catch {
      results.push({ address, status: 'invalid', method: 'dns_mx', confidence: 90, evidence: { ...source, reason: 'MX lookup failed' } });
    }
  }
  return results.sort((left, right) => {
    const leftObserved = left.evidence.sourceType === 'generated_pattern' ? 0 : 1;
    const rightObserved = right.evidence.sourceType === 'generated_pattern' ? 0 : 1;
    if (leftObserved !== rightObserved) return rightObserved - leftObserved;
    const leftDomain = left.address.split('@')[1]?.toLowerCase();
    const rightDomain = right.address.split('@')[1]?.toLowerCase();
    const ownerName = normalizeNameForComparison(fullName).split(' ').filter(Boolean);
    const isOwnerAddress = (address: string) => {
      if (ownerName.length < 2 || normalizeNameForComparison(fullName) === normalizeNameForComparison(candidate.name)) return 0;
      const local = address.split('@')[0]!.replace(/[^a-z]/g, '');
      return local.includes(ownerName[0]!) && local.includes(ownerName.at(-1)!) ? 1 : 0;
    };
    const leftOwner = isOwnerAddress(left.address);
    const rightOwner = isOwnerAddress(right.address);
    if (leftOwner !== rightOwner) return rightOwner - leftOwner;
    const leftMatch = domain && leftDomain === domain ? 1 : 0;
    const rightMatch = domain && rightDomain === domain ? 1 : 0;
    if (leftMatch !== rightMatch) return rightMatch - leftMatch;

    const isGenericLeft = /^(?:info|contact|sales|admin|support|hello|enquiries|office|help)@/i.test(left.address) ? 1 : 0;
    const isGenericRight = /^(?:info|contact|sales|admin|support|hello|enquiries|office|help)@/i.test(right.address) ? 1 : 0;
    if (isGenericLeft !== isGenericRight) return isGenericLeft - isGenericRight;

    const leftHasDot = left.address.split('@')[0]?.includes('.') ? 1 : 0;
    const rightHasDot = right.address.split('@')[0]?.includes('.') ? 1 : 0;
    if (leftHasDot !== rightHasDot) return rightHasDot - leftHasDot;

    return right.confidence - left.confidence;
  });
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
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.POSTA_API_KEY}`,
      'user-agent': 'LeadForge/1.0',
    },
    body: JSON.stringify({
      from: config.POSTA_FROM,
      to: [to],
      subject,
      html: `<p>${escapeHtml(body).replace(/\n/g, '<br>')}</p>`,
    }),
  });
  if (!response.ok) throw new Error(`Posta error ${response.status}: ${await response.text()}`);
  const payload = (await response.json()) as { id?: string; status?: string; data?: { id?: string; status?: string } };
  const id = payload.data?.id ?? payload.id ?? '';
  const status = payload.data?.status ?? payload.status ?? 'queued';
  return { id, status };
}

async function searchPublicWeb(query: string): Promise<PublicSearchResult[]> {
  try {
    const response = await fetch(`${config.SEARXNG_URL}/search?format=json&engines=bing,yahoo&q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(7_000) });
    if (!response.ok) {
      console.warn(`[searchPublicWeb] SearXNG HTTP ${response.status} for query: ${query.slice(0, 60)}`);
      return [];
    }
    const data = await response.json() as { results?: PublicSearchResult[] };
    return (data.results ?? []).slice(0, 20);
  } catch (error) {
    console.warn(`[searchPublicWeb] SearXNG search failed for "${query.slice(0, 60)}":`, error instanceof Error ? error.message : String(error));
    return [];
  }
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
  let email = value.trim().toLowerCase().replace(/^mailto:/, '').split('?')[0]!;
  if (!email || email.length > 254) return undefined;
  // Clean concatenated trailing text from HTML tag stripping (e.g. .co.zamore, .comphone, .inphone)
  email = email.replace(/(\.(?:co\.[a-z]{2}|org\.[a-z]{2}|ac\.[a-z]{2}|gov\.[a-z]{2}|[a-z]{2,8}))(phone|call|tel|fax|more|contact|click|view|here|about|email|mail|address|website|web|open|close|mon|tue|wed|thu|fri|sat|sun)\b.*$/i, '$1');
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)) return undefined;
  const [userPart, hostPart] = email.split('@');
  if (!userPart || !hostPart) return undefined;
  // Filter dummy sample emails common on directory previews (e.g. prospeo, hunter, zoominfo sample placeholders)
  if (/^(?:john|doe|john\.doe|johndoe|jane|jane\.doe|janedoe|sample|test|placeholder|yourname|user)$/i.test(userPart)) return undefined;
  if (/(?:example|domain|email|sentry|anthropic|openai|github|wixpress|wordpress|shopify|cloudflare)\.(?:com|org|net|io|ai)$/i.test(hostPart)) return undefined;
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
