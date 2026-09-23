import { describe, expect, it } from 'vitest';
import {
  extractEmails, extractEvidence, extractPhones, hybridQualificationScore, mapsDepthFor, parseStringList,
} from './providers.js';

describe('public contact extraction', () => {
  it('normalizes Maps email arrays and separated values', () => {
    expect(parseStringList('["hello@example.org","owner@gmail.com"]')).toEqual(['hello@example.org', 'owner@gmail.com']);
    expect(parseStringList('sales@example.org; team@gmail.com')).toEqual(['sales@example.org', 'team@gmail.com']);
  });

  it('extracts normal and lightly obfuscated public emails', () => {
    expect(extractEmails('Contact owner@gmail.com or sales [at] acme [dot] in')).toEqual(['owner@gmail.com', 'sales@acme.in']);
  });

  it('extracts and normalizes public phone numbers', () => {
    expect(extractPhones('Call +91 98765 43210 or (06762) 221-900')).toEqual(['+919876543210', '06762221900']);
  });

  it('scales Maps depth with the requested volume and query count', () => {
    expect(mapsDepthFor(100, 10)).toBe(1);
    expect(mapsDepthFor(2_000, 12)).toBe(10);
  });

  it('does not let an anomalous AI score discard stronger deterministic evidence', () => {
    expect(hybridQualificationScore(74, 0)).toBe(74);
    expect(hybridQualificationScore(52, 88)).toBe(88);
    expect(hybridQualificationScore(65, 'invalid')).toBe(65);
  });

  it('requires direct purchase controls instead of payment-provider mentions', () => {
    const candidate = { name: 'Acme', country: 'India', website: 'https://acme.test' };
    const mentionOnly = extractEvidence([{ url: candidate.website, html: '<html><body>Payments may be handled by PayPal.</body></html>' }], candidate);
    expect(mentionOnly.capabilities.onlinePurchase.status).toBe('not_detected');
    const checkout = extractEvidence([{ url: candidate.website, html: '<html><body><a href="/checkout">Buy now</a></body></html>' }], candidate);
    expect(checkout.capabilities.onlinePurchase.status).toBe('detected');
  });

  it('extracts contacts and social profiles from structured website data', () => {
    const candidate = { name: 'Acme', country: 'India', website: 'https://acme.test' };
    const evidence = extractEvidence([{ url: candidate.website, html: '<script type="application/ld+json">{"@type":"Organization","email":"hello@acme.test","telephone":"+91 98765 43210","sameAs":["https://instagram.com/acme"]}</script><body>Acme</body>' }], candidate);
    expect(evidence.emails).toContain('hello@acme.test');
    expect(evidence.phones).toContain('+919876543210');
    expect(evidence.socialLinks).toContain('https://instagram.com/acme');
  });
});
