import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from './config.js';
import { buildDiscoveryKeywords, discoverBusinesses } from './providers.js';
import { RunPausedError } from './run-control.js';

const originalMode = config.PROVIDER_MODE;
const input = { name: 'Test', country: 'India', cities: ['Mumbai', 'Bangalore', 'Bhubaneswar'], businessTypes: ['dentist', 'agency', 'construction', 'garments'], targetCount: 3000 };
afterEach(() => { config.PROVIDER_MODE = originalMode; vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('bounded Maps jobs and resumable checkpoints', () => {
  it('expands large targets beyond the original city/category queries', () => {
    const keywords = buildDiscoveryKeywords(input);
    expect(keywords.length).toBeGreaterThan(12);
    expect(new Set(keywords).size).toBe(keywords.length);
    for (const city of input.cities) for (const category of input.businessTypes) {
      expect(keywords).toContain(`${category} in ${city}, India`);
    }
  });
  it('submits the actual upstream depth/time fields and saves the Maps job ID', async () => {
    config.PROVIDER_MODE = 'live'; vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: 'maps-checkpoint' }))
      .mockResolvedValueOnce(Response.json({ results: [{ place_id: 'place1', title: 'Dental', phone: '+919999999999', emails: ['owner@example.org'] }] }));
    vi.stubGlobal('fetch', fetchMock);
    const saveJob = vi.fn(async () => {});
    const result = discoverBusinesses(input, async () => false, { keywords: ['dentist in Mumbai, India'], saveJob });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject([{ sourceId: 'place1', phone: '+919999999999', publicEmails: ['owner@example.org'] }]);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({ depth: 10, max_time: 300, email: true, keywords: ['dentist in Mumbai, India'] });
    expect(saveJob).toHaveBeenCalledExactlyOnceWith('maps-checkpoint');
  });
  it('resumes polling a saved job without submitting a duplicate Maps request', async () => {
    config.PROVIDER_MODE = 'live'; vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ results: [{ place_id: 'p', title: 'Company' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const saveJob = vi.fn(async () => {});
    const result = discoverBusinesses(input, async () => false, { jobId: 'saved-job', keywords: ['query'], saveJob });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toContain('/jobs/saved-job');
    expect(saveJob).not.toHaveBeenCalled();
  });
  it('does not submit upstream work when paused or stopped', async () => {
    config.PROVIDER_MODE = 'live';
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(discoverBusinesses(input, async () => true)).resolves.toEqual([]);
    await expect(discoverBusinesses(input, async () => { throw new RunPausedError(); })).rejects.toThrow(RunPausedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
