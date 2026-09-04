// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  isQueueRowClaimable,
  queueChainHeads,
  queueRetryDelayMs,
  QUEUE_CLAIM_STALE_MS,
  type ReplayableRow,
  type QueueSyncStatus,
} from './queue-replay.js';

const T0 = Date.parse('2026-09-03T12:00:00.000Z');
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function row(over: Partial<ReplayableRow> & { queuedAt: string }): ReplayableRow {
  return {
    dataLayerId: 'dl1',
    layerKey: 'main',
    globalId: 'f1',
    syncStatus: 'pending' as QueueSyncStatus,
    ...over,
  };
}

describe('queueRetryDelayMs', () => {
  it('does not delay the first retry', () => {
    expect(queueRetryDelayMs(0)).toBe(0);
    expect(queueRetryDelayMs(undefined)).toBe(0);
  });

  it('climbs and then caps', () => {
    expect(queueRetryDelayMs(1)).toBe(5_000);
    expect(queueRetryDelayMs(3)).toBe(60_000);
    const cap = queueRetryDelayMs(5);
    expect(queueRetryDelayMs(50)).toBe(cap);
    expect(queueRetryDelayMs(5000)).toBe(cap);
  });

  it('treats a nonsense count as no delay rather than throwing', () => {
    expect(queueRetryDelayMs(-3)).toBe(0);
  });
});

describe('isQueueRowClaimable', () => {
  it('never claims a parked row', () => {
    const r = row({ queuedAt: at(0), syncStatus: 'rejected' });
    expect(isQueueRowClaimable(r, T0 + 1e9)).toBe(false);
    // Not even for a person pressing Sync now: retrying a rejected row
    // goes through retryRejected, which puts it back to pending.
    expect(isQueueRowClaimable(r, T0 + 1e9, { ignoreBackoff: true })).toBe(
      false,
    );
  });

  it('leaves a fresh in-flight claim alone', () => {
    const r = row({
      queuedAt: at(0),
      syncStatus: 'syncing',
      lastAttemptAt: at(0),
    });
    expect(isQueueRowClaimable(r, T0 + 1_000)).toBe(false);
  });

  it('reclaims an abandoned claim once it goes stale', () => {
    const r = row({
      queuedAt: at(0),
      syncStatus: 'syncing',
      lastAttemptAt: at(0),
    });
    expect(isQueueRowClaimable(r, T0 + QUEUE_CLAIM_STALE_MS)).toBe(true);
  });

  it('reclaims a claim with no timestamp instead of stranding it', () => {
    const r = row({ queuedAt: at(0), syncStatus: 'syncing' });
    expect(isQueueRowClaimable(r, T0)).toBe(true);
  });

  it('holds a failed row back for its backoff, then releases it', () => {
    const r = row({
      queuedAt: at(0),
      syncStatus: 'failed',
      retryCount: 2,
      lastAttemptAt: at(0),
    });
    expect(queueRetryDelayMs(2)).toBe(15_000);
    expect(isQueueRowClaimable(r, T0 + 14_000)).toBe(false);
    expect(isQueueRowClaimable(r, T0 + 15_000)).toBe(true);
  });

  it('lets a person override the backoff', () => {
    const r = row({
      queuedAt: at(0),
      syncStatus: 'failed',
      retryCount: 4,
      lastAttemptAt: at(0),
    });
    expect(isQueueRowClaimable(r, T0 + 1_000)).toBe(false);
    expect(isQueueRowClaimable(r, T0 + 1_000, { ignoreBackoff: true })).toBe(
      true,
    );
  });
});

describe('queueChainHeads', () => {
  it('takes only the oldest row per feature', () => {
    const a = row({ queuedAt: at(0), globalId: 'f1' });
    const b = row({ queuedAt: at(10), globalId: 'f1' });
    const heads = queueChainHeads([b, a], T0 + 1e6);
    expect(heads).toHaveLength(1);
    expect(heads[0]).toBe(a);
  });

  it('skips a whole feature whose oldest row is parked', () => {
    // The insert was refused. Replaying the later update would PATCH a
    // feature the server has never seen, 404, and park a second row,
    // turning one refusal into two lost edits.
    const rejectedInsert = row({
      queuedAt: at(0),
      globalId: 'f1',
      syncStatus: 'rejected',
    });
    const laterEdit = row({ queuedAt: at(10), globalId: 'f1' });
    expect(queueChainHeads([rejectedInsert, laterEdit], T0 + 1e6)).toEqual([]);
  });

  it('skips a feature whose oldest row is in flight elsewhere', () => {
    const inFlight = row({
      queuedAt: at(0),
      globalId: 'f1',
      syncStatus: 'syncing',
      lastAttemptAt: at(0),
    });
    const queuedBehind = row({ queuedAt: at(10), globalId: 'f1' });
    expect(queueChainHeads([inFlight, queuedBehind], T0 + 1_000)).toEqual([]);
  });

  it('does not let one blocked feature hold up another', () => {
    const blocked = row({
      queuedAt: at(0),
      globalId: 'blocked',
      syncStatus: 'rejected',
    });
    const fine = row({ queuedAt: at(5), globalId: 'fine' });
    expect(queueChainHeads([blocked, fine], T0 + 1e6)).toEqual([fine]);
  });

  it('treats the same globalId under a different layer as a different feature', () => {
    const a = row({ queuedAt: at(0), globalId: 'f1', layerKey: 'sites' });
    const b = row({ queuedAt: at(1), globalId: 'f1', layerKey: 'readings' });
    expect(queueChainHeads([a, b], T0 + 1e6)).toHaveLength(2);
  });

  it('returns heads in capture order across features', () => {
    const later = row({ queuedAt: at(100), globalId: 'b' });
    const earlier = row({ queuedAt: at(1), globalId: 'a' });
    expect(queueChainHeads([later, earlier], T0 + 1e6)).toEqual([
      earlier,
      later,
    ]);
  });

  it('is empty for an empty queue', () => {
    expect(queueChainHeads([], T0)).toEqual([]);
  });
});
