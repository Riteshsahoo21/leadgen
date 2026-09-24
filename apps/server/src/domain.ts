import { z } from 'zod';

const commaList = z.union([z.string(), z.array(z.string())]).transform((value, context) => {
  const items = (Array.isArray(value) ? value : value.split(','))
    .map((item) => item.trim())
    .filter(Boolean);
  const unique = [...new Set(items.map((item) => item.replace(/\s+/g, ' ')))];
  if (unique.length === 0) {
    context.addIssue({ code: 'custom', message: 'Enter at least one value' });
    return z.NEVER;
  }
  return unique;
});

export const createRunSchema = z.object({
  name: z.string().trim().min(2).max(100),
  country: z.string().trim().min(2).max(80),
  cities: commaList.pipe(z.array(z.string().max(80)).max(50)),
  businessTypes: commaList.pipe(z.array(z.string().max(80)).max(50)),
  targetCount: z.coerce.number().int().min(1).max(50000).default(5000),
});

export type CreateRunInput = z.infer<typeof createRunSchema>;

export type BusinessCandidate = {
  sourceId?: string | undefined;
  name: string;
  category?: string | undefined;
  categories?: string[] | undefined;
  country: string;
  city?: string | undefined;
  address?: string | undefined;
  phone?: string | undefined;
  website?: string | undefined;
  rating?: number | undefined;
  reviewCount?: number | undefined;
  latitude?: number | undefined;
  longitude?: number | undefined;
  publicEmails?: string[] | undefined;
  owner?: { name: string; sourceUrl?: string | undefined } | undefined;
  raw?: Record<string, unknown> | undefined;
};

export function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
}

export function normalizeDomain(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

export function calculateFilterScore(candidate: BusinessCandidate): { score: number; reasons: string[] } {
  let score = 20;
  const reasons: string[] = ['Active discovery result'];
  if (candidate.phone) { score += 20; reasons.push('Phone available'); }
  if (candidate.website) { score += 20; reasons.push('Website available'); }
  else { score += 10; reasons.push('No website: potential website lead'); }
  if ((candidate.reviewCount ?? 0) >= 10) { score += 15; reasons.push('Established review history'); }
  if ((candidate.reviewCount ?? 0) >= 100) { score += 10; reasons.push('Strong review volume'); }
  if ((candidate.rating ?? 0) >= 3.5) { score += 10; reasons.push('Healthy rating'); }
  if (candidate.address) { score += 5; reasons.push('Address available'); }
  return { score: Math.min(score, 100), reasons };
}

export type QualificationEvidence = {
  hasBooking?: boolean;
  hasContactForm?: boolean;
  hasPayment?: boolean;
  pagesCrawled?: number;
  publicEmails?: number;
  publicPhones?: number;
  socialProfiles?: number;
  crawlFailed?: boolean;
};

export type QualificationScoreBreakdown = {
  need: number;
  businessStrength: number;
  reachability: number;
  evidenceQuality: number;
  penalty: number;
  total: number;
  signals: string[];
};

export function calculateQualificationScore(candidate: BusinessCandidate, evidence: QualificationEvidence = {}) {
  const pagesCrawled = Math.max(0, Number(evidence.pagesCrawled ?? 0));
  const category = `${candidate.category ?? ''} ${(candidate.categories ?? []).join(' ')}`;
  const bookingRelevant = /dentist|clinic|doctor|salon|spa|hotel|restaurant|consult|agency|repair|service|contractor|law|account|real estate|fitness/i.test(category);
  const commerceRelevant = /restaurant|retail|store|shop|e-?commerce|clothing|garment|food|bakery|delivery/i.test(category);
  const painPoints: string[] = [];
  const signals: string[] = [];
  let opportunity = 'website_present';
  let need = 0;

  if (!candidate.website) {
    opportunity = 'new_website';
    need = 40;
    painPoints.push('No detected website');
    signals.push('No website creates a clear build opportunity');
  } else if (evidence.crawlFailed || pagesCrawled === 0) {
    opportunity = 'manual_review';
    need = 12;
    painPoints.push('Website could not be evaluated from public pages');
    signals.push('Website evidence is incomplete, so the lead needs manual review');
  } else {
    const gaps: Array<{ points: number; painPoint: string; signal: string }> = [];
    if (evidence.hasContactForm === false) gaps.push({
      points: 16,
      painPoint: `No contact form detected on ${pagesCrawled} checked page${pagesCrawled === 1 ? '' : 's'}`,
      signal: 'No direct website enquiry form was detected',
    });
    if (bookingRelevant && evidence.hasBooking === false) gaps.push({
      points: 12,
      painPoint: `No online booking flow detected on ${pagesCrawled} checked page${pagesCrawled === 1 ? '' : 's'}`,
      signal: 'A booking-oriented business has no detected online booking flow',
    });
    if (commerceRelevant && evidence.hasPayment === false) gaps.push({
      points: 12,
      painPoint: `No online ordering or purchase flow detected on ${pagesCrawled} checked page${pagesCrawled === 1 ? '' : 's'}`,
      signal: 'A commerce-oriented business has no detected purchase flow',
    });
    if (gaps.length) {
      opportunity = 'website_improvement';
      need = Math.min(40, 8 + gaps.reduce((sum, gap) => sum + gap.points, 0));
      painPoints.push(...gaps.map((gap) => gap.painPoint));
      signals.push(...gaps.map((gap) => gap.signal));
    } else {
      painPoints.push('No clear website conversion gap detected on checked pages');
      signals.push('The checked pages already expose the relevant conversion paths');
    }
  }

  const reviews = Math.max(0, candidate.reviewCount ?? 0);
  // Log scaling prevents very large review counts from overwhelming every other signal.
  const reviewStrength = Math.round(14 * Math.log1p(Math.min(reviews, 2_000)) / Math.log1p(2_000));
  // Bayesian shrinkage prevents a five-star business with only a few reviews from outranking established businesses.
  const priorRating = 3.8;
  const priorReviews = 20;
  const adjustedRating = candidate.rating == null
    ? priorRating
    : ((candidate.rating * reviews) + (priorRating * priorReviews)) / (reviews + priorReviews);
  const ratingStrength = Math.round(10 * clamp((adjustedRating - 3.2) / 1.6, 0, 1));
  const locationStrength = candidate.address ? 3 : 0;
  const businessStrength = reviewStrength + ratingStrength + locationStrength;
  if (reviews) signals.push(`${reviews} reviews contribute ${reviewStrength} traction points`);
  if (candidate.rating != null) signals.push(`Bayesian-adjusted rating ${adjustedRating.toFixed(2)}/5`);

  const publicEmails = Math.max(candidate.publicEmails?.length ?? 0, evidence.publicEmails ?? 0);
  const publicPhones = Math.max(candidate.phone ? 1 : 0, evidence.publicPhones ?? 0);
  const socialProfiles = Math.max(0, evidence.socialProfiles ?? 0);
  const reachability = Math.min(20,
    (publicPhones ? 8 : 0) + (publicEmails ? 8 : 0) + (socialProfiles ? 2 : 0) + (evidence.hasContactForm ? 2 : 0));
  if (publicEmails) signals.push('A public email improves contactability');
  if (publicPhones) signals.push('A public phone improves contactability');

  const evidenceQuality = Math.min(13,
    (candidate.sourceId ? 2 : 0) + (candidate.address ? 2 : 0) + Math.min(7, pagesCrawled * 2) + ((publicEmails || publicPhones) ? 2 : 0));
  const penalty = evidence.crawlFailed ? 10 : 0;
  let total = Math.round(clamp(need + businessStrength + reachability + evidenceQuality - penalty, 0, 100));
  if (opportunity === 'website_present') total = Math.min(total, 49);
  if (opportunity === 'manual_review') total = Math.min(total, 55);

  const breakdown: QualificationScoreBreakdown = {
    need, businessStrength, reachability, evidenceQuality, penalty, total, signals: signals.slice(0, 8),
  };
  return { score: total, opportunity, painPoints, breakdown };
}

export function opportunityFor(candidate: BusinessCandidate, evidence?: QualificationEvidence) {
  const result = calculateQualificationScore(candidate, evidence);
  return { opportunity: result.opportunity, painPoints: result.painPoints };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
