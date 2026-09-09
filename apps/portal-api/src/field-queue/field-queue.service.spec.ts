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

  it('only keeps a numeric attempts', () => {
    const [out] = sanitizeManifest([
      entry([
        record({ attempts: 3 }),
        record({ id: 'r2', attempts: '3' }),
      ]),
    ]);
    expect(out!.queuedRecords[0]!.attempts).toBe(3);
    expect('attempts' in out!.queuedRecords[1]!).toBe(false);
  });

  it('keeps a structured failure message as posted', () => {
    const lastError = {
      code: 'sync.serverRefused',
      params: { serverMessage: 'Depth must be a number.' },
    };
    const [out] = sanitizeManifest([entry([record({ lastError })])]);
    expect(out!.queuedRecords[0]!.lastError).toEqual(lastError);
  });

  it('coerces a sentence from an older client into legacy.text', () => {
    // Clients older than offline schema v4 post the English the drain
    // composed. It is still the only record of why that edit is stuck,
    // so it is carried rather than dropped, in the one shape the admin
    // view knows how to render as is.
    const [out] = sanitizeManifest([
      entry([record({ lastError: 'POST failed (500). boom' })]),
    ]);
    expect(out!.queuedRecords[0]!.lastError).toEqual({
      code: 'legacy.text',
      params: { text: 'POST failed (500). boom' },
    });
  });

  it('keeps a code from a newer client instead of blanking the reason', () => {
    // The device is ahead of the portal. Dropping this would destroy
    // the only evidence of why a stuck edit was refused, and the admin
    // view renders an unknown code as a fallback that names it.
    const [out] = sanitizeManifest([
      entry([
        record({
          lastError: { code: 'sync.somethingNewer', params: { status: 418 } },
        }),
      ]),
    ]);
    expect(out!.queuedRecords[0]!.lastError).toEqual({
      code: 'sync.somethingNewer',
      params: { status: 418 },
    });
  });

  it('refuses a code that is not shaped like one, and bounds the params', () => {
    // A malformed code is the one case with nothing a future build
    // could render either, so it becomes null. Everything that IS
    // stored is bounded: this table is written by whatever a client
    // posts.
    const [out] = sanitizeManifest([
      entry([
        record({ id: 'r1', lastError: { code: 'not a code at all' } }),
        record({ id: 'r2', lastError: { code: 'x'.repeat(80) } }),
        record({ id: 'r3', lastError: { code: 42 } }),
        record({ id: 'r4', lastError: 42 }),
        record({ id: 'r5', lastError: ['sync.requestFailed'] }),
        record({
          id: 'r6',
          lastError: {
            code: 'sync.serverRefused',
            params: { serverMessage: 'x'.repeat(900), nested: { a: 1 } },
          },
        }),
      ]),
    ]);
    const errors = out!.queuedRecords.map((r) => r.lastError);
    expect(errors.slice(0, 5)).toEqual([null, null, null, null, null]);
    expect(errors[5]).toEqual({
      code: 'sync.serverRefused',
      params: { serverMessage: 'x'.repeat(500) },
    });
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
