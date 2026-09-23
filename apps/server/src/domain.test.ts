import { describe, expect, it } from 'vitest';
import { calculateFilterScore, createRunSchema, normalizeDomain, normalizeName } from './domain.js';

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
