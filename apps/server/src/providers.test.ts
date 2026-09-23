import { describe, expect, it } from 'vitest';
import { extractEmails, extractPhones, parseStringList } from './providers.js';

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
});
