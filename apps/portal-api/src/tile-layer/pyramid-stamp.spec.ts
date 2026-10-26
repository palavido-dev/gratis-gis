// SPDX-License-Identifier: AGPL-3.0-or-later
import { pyramidClaimStillHeld } from './pyramid-claim.js';

/**
 * #232: pyramid success/failure stamps must not clobber a concurrent
 * mosaic rebuild. The worker gates the jsonb merge on
 * processingState='tiling' and (when known) the claimed cogStorageKey.
 */

describe('pyramidClaimStillHeld (#232)', () => {
  it('allows a stamp while the claim is still held', () => {
    expect(
      pyramidClaimStillHeld({
        processingState: 'tiling',
        cogStorageKey: 'item-tile-layer/abc',
        expectedCog: 'item-tile-layer/abc',
      }),
    ).toBe(true);
  });

  it('rejects when a concurrent rebuild flipped the state', () => {
    expect(
      pyramidClaimStillHeld({
        processingState: 'cog-ready',
        cogStorageKey: 'item-tile-layer/abc',
        expectedCog: 'item-tile-layer/abc',
      }),
    ).toBe(false);
  });

  it('rejects when the COG key was rewritten under us', () => {
    expect(
      pyramidClaimStillHeld({
        processingState: 'tiling',
        cogStorageKey: 'item-tile-layer/newer',
        expectedCog: 'item-tile-layer/abc',
      }),
    ).toBe(false);
  });

  it('skips the cog-key check for legacy URL-only claims', () => {
    expect(
      pyramidClaimStillHeld({
        processingState: 'tiling',
        cogStorageKey: null,
        expectedCog: null,
      }),
    ).toBe(true);
  });
});
