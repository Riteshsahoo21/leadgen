import { describe, expect, it } from 'vitest';
import { RunPausedError, runIsStopped } from './run-control.js';

describe('run lifecycle guards', () => {
  it('defers paused work instead of treating it as completed', () => {
    expect(() => runIsStopped('paused')).toThrow(RunPausedError);
  });
  it('stops missing, failed and cancelled runs', () => {
    for (const status of [undefined, 'cancelled', 'failed']) expect(runIsStopped(status)).toBe(true);
  });
  it('allows queued, running and explicitly backfilled completed runs', () => {
    for (const status of ['queued', 'running', 'completed']) expect(runIsStopped(status)).toBe(false);
  });
});
