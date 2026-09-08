// SPDX-License-Identifier: AGPL-3.0-or-later
import { sanitizeManifest, type ManifestEntry } from './field-queue.service.js';

/**
 * The manifest is client-posted metadata about a device's offline
 * queue, and the admin view renders exactly what this function keeps.
 * These specs pin the per-record status handling, which is where a new
 * terminal state on the device would otherwise be quietly coerced into
 * "still pending".
 */
type QueuedRecord = ManifestEntry['queuedRecords'][number];

/** Loosely typed on purpose: the input is whatever a client posted. */
function record(overrides: Record<string, unknown> = {}): QueuedRecord {
  return {
    id: 'r1',
    op: 'insert',
    layerId: 'layer-1',
    queuedAt: '2026-09-01T00:00:00.000Z',
    status: 'pending',
    ...overrides,
  } as QueuedRecord;
}

function entry(records: ManifestEntry['queuedRecords']): ManifestEntry {
  return { dataCollectionId: 'dc-1', cachedAt: null, queuedRecords: records };
}

describe('sanitizeManifest', () => {
  it('returns an empty manifest for a missing or non-array input', () => {
    expect(sanitizeManifest(null)).toEqual([]);
    expect(sanitizeManifest(undefined)).toEqual([]);
    expect(sanitizeManifest('nope' as unknown as ManifestEntry[])).toEqual([]);
  });

  it.each(['pending', 'failed', 'rejected'] as const)('passes status %j through', (status) => {
    const [out] = sanitizeManifest([entry([record({ status })])]);
    expect(out!.queuedRecords[0]!.status).toBe(status);
  });

  it('coerces an unknown status to pending rather than dropping the record', () => {
    const [out] = sanitizeManifest([
      entry([record({ status: 'exploded' }), record({ id: 'r2', status: undefined })]),
    ]);
    expect(out!.queuedRecords.map((r) => r.status)).toEqual(['pending', 'pending']);
  });

  it('coerces an unknown op to insert', () => {
    const [out] = sanitizeManifest([entry([record({ op: 'upsert' })])]);
    expect(out!.queuedRecords[0]!.op).toBe('insert');
  });

  it('trims lastError and only keeps a numeric attempts', () => {
    const [out] = sanitizeManifest([
      entry([
        record({ lastError: 'x'.repeat(500), attempts: 3 }),
        record({ id: 'r2', lastError: 42, attempts: '3' }),
      ]),
    ]);
    expect(out!.queuedRecords[0]!.lastError).toHaveLength(200);
    expect(out!.queuedRecords[0]!.attempts).toBe(3);
    expect(out!.queuedRecords[1]!.lastError).toBeNull();
    expect('attempts' in out!.queuedRecords[1]!).toBe(false);
  });

  it('caps deployments at 100 and records per deployment at 500', () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      entry(Array.from({ length: 600 }, (_, j) => record({ id: `r${i}-${j}` }))),
    );
    const out = sanitizeManifest(many);
    expect(out).toHaveLength(100);
    expect(out[0]!.queuedRecords).toHaveLength(500);
  });
});
