import { afterEach, describe, expect, it, vi } from 'vitest';
import { CheerioCrawler } from 'crawlee';
import { load } from 'cheerio';
import { config } from './config.js';
import {
  crawlWebsite, enrichEmails, extractEmails, extractEvidence, extractPhones, mapsDepthFor, parseStringList, searchResultMatchesBusiness, websiteIdentityMismatch,
} from './providers.js';

const originalMode = config.PROVIDER_MODE;
afterEach(() => { config.PROVIDER_MODE = originalMode; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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

  it('extracts emails from directory listings and mailto links', () => {
    const text = 'Director Aashish Partidar contact at aashish@telkomsa.net or call +27 11 837 8345';
    expect(extractEmails(text)).toContain('aashish@telkomsa.net');
    expect(extractPhones(text)).toContain('+27118378345');
  });

  it('rejects unrelated directory and government search results', () => {
    const candidate = { name: 'SP Home Constructions', country: 'India' };
    expect(searchResultMatchesBusiness({ title: 'Ministry of External Affairs', url: 'https://www.mea.gov.in/contact-tele-inquiry' }, candidate)).toBe(false);
    expect(searchResultMatchesBusiness({ title: 'SP Home Constructions | Bhubaneswar', url: 'https://example.org/sp-home-constructions' }, candidate)).toBe(true);
  });

  it('holds an unrelated website association for manual review', () => {
    const candidate = { name: 'SHREE MAA CONSTRUCTION', country: 'India', website: 'https://nearme.shreemaruti.com/location/gujarat/' };
    expect(websiteIdentityMismatch(candidate,
      'Shree Maruti Courier Services in Ahmedabad',
      'Courier services in Gujarat', 'Find courier branches in Ahmedabad')).toBe(true);
    expect(websiteIdentityMismatch({ ...candidate, website: 'https://shreemaaconstruction.in' },
      'Shree Maa Construction', 'Bhubaneswar construction', 'Our projects')).toBe(false);
  });

  it('does not infer conversion features or a complete site from a challenge page or framework', () => {
    const candidate = { name: 'Acme', country: 'India', website: 'https://acme.test' };
    const challenge = extractEvidence([{ url: candidate.website, html: '<title>Just a moment...</title><script src="https://challenges.cloudflare.com/x"></script>' }], candidate);
    expect(challenge.crawlBlocked).toBe(true);
    expect(challenge.hasContactForm).toBe(false);
    expect(challenge.hasBooking).toBe(false);
    const landing = extractEvidence([{ url: candidate.website, html: '<meta name="viewport" content="width=device-width"><script src="/_next/static/app.js"></script><body>Welcome to Acme</body>' }], candidate);
    expect(landing.isModernPresence).toBe(false);
  });

  it('falls back to HTTP when the HTTPS homepage fails and keeps a short landing page', async () => {
    config.PROVIDER_MODE = 'live';
    const runCalls: string[] = [];
    vi.spyOn(CheerioCrawler.prototype, 'run').mockImplementation(async function (this: any, requests: any) {
      const url = String(requests?.[0] ?? '');
      runCalls.push(url);
      if (url.startsWith('https:')) throw new Error('TLS failed');
      const $ = load('<html><title>Acme</title><body>Welcome to Acme.</body></html>');
      const request = { url, loadedUrl: url };
      await (this as any).requestHandler({ $, request, enqueueLinks: vi.fn() });
    });

    const evidence = await crawlWebsite({ name: 'Acme', country: 'India', website: 'https://acme.test' });
    expect(evidence.pagesCrawled).toBe(1);
    expect(evidence.hasSsl).toBe(false);
    expect(evidence.usedBrowser).toBe(false);
    expect(runCalls).toHaveLength(2);
    expect(runCalls[0]).toBe('https://acme.test/');
    expect(runCalls[1]).toBe('http://acme.test/');
  });

  it('prefers an observed owner address over a generic business mailbox', async () => {
    const candidate = { name: 'Acme Dental', country: 'India', website: 'https://acme.test' };
    const emails = await enrichEmails(candidate, 'Anika Rao', [
      { kind: 'email', value: 'info@acme.test', sourceType: 'company_website' },
      { kind: 'email', value: 'anika.rao@gmail.com', sourceType: 'company_website' },
    ]);
    expect(emails[0]?.address).toBe('anika.rao@gmail.com');
  });

  it('strips trailing words concatenated during HTML tag stripping', () => {
    expect(extractEmails('info.construction@concor.co.zamore')).toEqual(['info.construction@concor.co.za']);
    expect(extractEmails('care@pharmeasy.inphone')).toEqual(['care@pharmeasy.in']);
  });
});
