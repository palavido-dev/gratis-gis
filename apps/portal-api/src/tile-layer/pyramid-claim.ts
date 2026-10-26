// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Predicate the pyramid success/failure stamp SQL encodes (#232).
 * Keep in sync with `TileLayerPyramidWorker.applyPatch`'s WHERE clause:
 * a concurrent mosaic rebuild that flipped processingState or rewrote
 * cogStorageKey must not be clobbered by a late pyramid write.
 */
export function pyramidClaimStillHeld(args: {
  processingState: string | null | undefined;
  cogStorageKey: string | null | undefined;
  expectedCog: string | null;
}): boolean {
  if (args.processingState !== 'tiling') return false;
  if (args.expectedCog === null) return true;
  return (args.cogStorageKey ?? null) === args.expectedCog;
}
