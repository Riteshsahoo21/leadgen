import { describe, expect, it } from 'vitest';
import { calculateFilterScore, calculateQualificationScore, createRunSchema, normalizeDomain, normalizeName } from './domain.js';

describe('discovery input', () => {
  it('normalizes comma-separated cities and business types', () => {
    const value = createRunSchema.parse({
      name: 'India outreach', country: 'India', cities: 'Mumbai, Pune, Mumbai',
      businessTypes: 'dentist, agency, dentist', targetCount: 5000,
    });
    expect(value.cities).toEqual(['Mumbai', 'Pune']);
    expect(value.businessTypes).toEqual(['dentist', 'agency']);
  });
});

describe('comparative qualification scoring', () => {
  const base = { name: 'Acme Dental', country: 'India', category: 'Dentist', phone: '+91 123', rating: 4.5, reviewCount: 180 };

  it('returns no-website and incomplete-website opportunities separately', () => {
    const missing = calculateQualificationScore(base);
    const incomplete = calculateQualificationScore({ ...base, website: 'https://acme.test' }, {
      pagesCrawled: 4, hasContactForm: false, hasBooking: false, publicPhones: 1,
    });
    expect(missing.opportunity).toBe('new_website');
    expect(incomplete.opportunity).toBe('website_improvement');
    expect(incomplete.painPoints).toHaveLength(1);
  });

  it('keeps complete sites below actionable scores and varies scores by business strength', () => {
    const complete = calculateQualificationScore({ ...base, website: 'https://acme.test' }, {
      pagesCrawled: 4, hasContactForm: true, hasBooking: true, publicPhones: 1, isModernPresence: true,
    });
    const strong = calculateQualificationScore(base);
    const weak = calculateQualificationScore({ ...base, phone: undefined, rating: 3.2, reviewCount: 2 });
    expect(complete.opportunity).toBe('website_present');
    expect(complete.score).toBeLessThan(50);
    expect(strong.opportunity).toBe('new_website');
    expect(strong.score).toBeGreaterThanOrEqual(65);
    expect(strong.score).toBeGreaterThan(weak.score);
  });

  it('does not mistake a multi-page contractor site for incomplete solely because it has no booking or form', () => {
    const contractor = { ...base, category: 'Building contractor', website: 'https://builder.test' };
    const result = calculateQualificationScore(contractor, {
      pagesCrawled: 7, hasSsl: true, hasViewport: true,
      hasContactForm: false, hasBooking: false, hasPayment: false, publicPhones: 1,
    });
    expect(result.opportunity).toBe('website_present');
  });

  it('holds blocked or failed crawls for review instead of treating them as broken websites', () => {
    const candidate = { ...base, website: 'https://acme.test' };
    for (const evidence of [{ crawlBlocked: true, pagesCrawled: 1 }, { crawlFailed: true, pagesCrawled: 0 }]) {
      const result = calculateQualificationScore(candidate, evidence);
      expect(result.opportunity).toBe('manual_review');
      expect(result.score).toBeLessThan(50);
    }
  });

  it('recognizes a functioning single-page website and flags a landing page without a conversion path', () => {
    const candidate = { ...base, website: 'https://acme.test' };
    const complete = calculateQualificationScore(candidate, {
      pagesCrawled: 1, hasSsl: true, hasViewport: true, hasContactForm: true, hasBooking: true,
    });
    const incomplete = calculateQualificationScore(candidate, {
      pagesCrawled: 1, hasSsl: true, hasViewport: true, hasContactForm: false, hasBooking: false,
    });
    expect(complete.opportunity).toBe('website_present');
    expect(calculateQualificationScore(candidate, {
      pagesCrawled: 1, hasSsl: true, hasViewport: true, hasContactForm: true, hasBooking: true, isOutdated: true,
    }).opportunity).toBe('website_present');
    expect(incomplete.opportunity).toBe('website_improvement');
  });

  it('qualifies low-score websites with missing SSL and viewport, but disqualifies modern sites', () => {
    const lowScore = calculateQualificationScore({ ...base, website: 'http://oldacme.test' }, {
      pagesCrawled: 1, hasSsl: false, hasViewport: false, hasContactForm: false, hasBooking: false,
    });
    const modernSite = calculateQualificationScore({ ...base, website: 'https://modernacme.test' }, {
      pagesCrawled: 5, hasSsl: true, hasViewport: true, isModernPresence: true, technologies: ['Next.js', 'Tailwind'],
    });
    expect(lowScore.opportunity).toBe('website_improvement');
    expect(lowScore.score).toBeGreaterThanOrEqual(60);
    expect(modernSite.opportunity).toBe('website_present');
    expect(modernSite.score).toBeLessThan(50);
  });
});

describe('lead normalization and filtering', () => {
  it('normalizes company names and domains', () => {
    expect(normalizeName('  ABC & Sons Pvt. Ltd. ')).toBe('abc sons pvt ltd');
    expect(normalizeDomain('https://www.Example.com/contact')).toBe('example.com');
  });

  it('keeps a no-website business when it has useful evidence', () => {
    const result = calculateFilterScore({
      name: 'ABC Furniture', country: 'India', phone: '+91 123', reviewCount: 245, rating: 4.4,
    });
    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(result.reasons).toContain('No website: potential website lead');
  });
});
