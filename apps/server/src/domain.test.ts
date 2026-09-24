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
    expect(incomplete.painPoints).toHaveLength(2);
  });

  it('keeps complete sites below actionable scores and varies scores by business strength', () => {
    const complete = calculateQualificationScore({ ...base, website: 'https://acme.test' }, {
      pagesCrawled: 4, hasContactForm: true, hasBooking: true, publicPhones: 1,
    });
    const strong = calculateQualificationScore(base);
    const weak = calculateQualificationScore({ ...base, phone: undefined, rating: 3.2, reviewCount: 2 });
    expect(complete.opportunity).toBe('website_present');
    expect(complete.score).toBeLessThan(50);
    expect(strong.score).toBeGreaterThan(weak.score);
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
