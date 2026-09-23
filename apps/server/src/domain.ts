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

export function opportunityFor(candidate: BusinessCandidate, evidence?: { hasBooking?: boolean; hasContactForm?: boolean }) {
  if (!candidate.website) return { opportunity: 'new_website', painPoints: ['No detected website'] };
  const painPoints: string[] = [];
  if (!evidence?.hasBooking) painPoints.push('No online booking detected');
  if (!evidence?.hasContactForm) painPoints.push('No contact form detected');
  if (painPoints.length === 0) painPoints.push('Website conversion path can be reviewed');
  return { opportunity: 'website_improvement', painPoints };
}
