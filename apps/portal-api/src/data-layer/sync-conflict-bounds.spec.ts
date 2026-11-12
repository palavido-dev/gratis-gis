// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sync conflict entries copied both sides of the feature into
// item.data with no byte cap; about twenty 9 MB edits crashed the API.

import {
  SYNC_CONFLICT_RING_MAX_BYTES,
  SYNC_CONFLICT_SIDE_MAX_BYTES,
  boundConflictSide,
  trimConflictRing,
} from './features.service.js';

describe('sync conflict bounds', () => {
  it('keeps a normal side whole', () => {
    const side = { id: 'f1', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { a: 1 } };
    expect(boundConflictSide(side)).toBe(side);
    expect(boundConflictSide(null)).toBeNull();
  });

  it('replaces an oversized side with its id and attributes', () => {
    const side = { id: 'f1', geometry: { type: 'LineString', coordinates: Array.from({ length: 50_000 }, (_, i) => [i, i]) }, properties: { a: 1 } };
    const out = boundConflictSide(side) as { truncated: boolean; id: string; properties: unknown };
    expect(out.truncated).toBe(true);
    expect(out.id).toBe('f1');
    expect(out.properties).toEqual({ a: 1 });
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(SYNC_CONFLICT_SIDE_MAX_BYTES);
  });

  it('drops oldest entries past the list budget', () => {
    const entry = (n: number) => ({ n, pad: 'x'.repeat(30 * 1024) });
    const ring = trimConflictRing(Array.from({ length: 50 }, (_, i) => entry(i)));
    expect(Buffer.byteLength(JSON.stringify(ring))).toBeLessThanOrEqual(SYNC_CONFLICT_RING_MAX_BYTES);
    expect(ring[ring.length - 1]!.n).toBe(49);
  });
});
