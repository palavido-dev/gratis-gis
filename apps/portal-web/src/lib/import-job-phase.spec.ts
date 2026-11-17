// SPDX-License-Identifier: AGPL-3.0-or-later
import { importJobPhase, type ImportJobProgress } from './import-job-phase';

function job(over: Partial<ImportJobProgress>): ImportJobProgress {
  return {
    status: 'running',
    totalFeatures: 1000,
    processedFeatures: 0,
    insertedFeatures: 0,
    ...over,
  };
}

describe('importJobPhase', () => {
  it('reports queued and finished jobs as such', () => {
    expect(importJobPhase(job({ status: 'queued' }))).toBe('queued');
    expect(importJobPhase(job({ status: 'succeeded' }))).toBe('done');
    expect(importJobPhase(job({ status: 'failed' }))).toBe('done');
    expect(importJobPhase(job({ status: 'cancelled' }))).toBe('done');
  });

  it('is starting before the first batch lands', () => {
    expect(importJobPhase(job({}))).toBe('starting');
  });

  it('is loading while features are still being read', () => {
    expect(importJobPhase(job({ processedFeatures: 5000, insertedFeatures: 5000, totalFeatures: 467_947 }))).toBe('loading');
  });

  it('is finishing once every feature is read but the job still runs (#573)', () => {
    expect(
      importJobPhase(job({ processedFeatures: 467_947, insertedFeatures: 467_900, totalFeatures: 467_947 })),
    ).toBe('finishing');
  });

  it('counts skipped features toward the total, not just inserted ones', () => {
    // Rows with undecodable geometry are skipped: inserted stays below
    // total even after the last feature is read.
    expect(importJobPhase(job({ processedFeatures: 1000, insertedFeatures: 990 }))).toBe('finishing');
  });

  it('never says finishing when the total is unknown', () => {
    expect(importJobPhase(job({ totalFeatures: null, processedFeatures: 5000 }))).toBe('loading');
    expect(importJobPhase(job({ totalFeatures: 0, processedFeatures: 5000 }))).toBe('loading');
  });
});
