// SPDX-License-Identifier: AGPL-3.0-or-later
import { cleanBbox, previewExtent } from './preview-extent';

const facilities = [-80.21436, 38.54308, -79.52206, 39.01175];

describe('previewExtent', () => {
  it('unions the layers that carry their own extent', () => {
    expect(previewExtent([[-81, 38, -80, 39], [-80.5, 37, -79, 38.5]], facilities)).toEqual([
      -81, 37, -79, 39,
    ]);
  });

  it('falls back to the item extent when no layer has one', () => {
    // Every sample layer on the demo: per-layer bbox missing, item bbox set.
    expect(previewExtent([null, undefined], facilities)).toEqual(facilities);
  });

  it('skips broken layer extents before falling back', () => {
    expect(previewExtent([[1, 2, 3], [Number.NaN, 0, 1, 1]], facilities)).toEqual(facilities);
  });

  it('is null when nothing usable is known', () => {
    expect(previewExtent([], null)).toBeNull();
    expect(previewExtent([], 'oops')).toBeNull();
  });
});

describe('cleanBbox', () => {
  it('refuses inverted and out-of-range boxes', () => {
    expect(cleanBbox([10, 0, 5, 1])).toBeNull();
    expect(cleanBbox([0, -95, 1, 1])).toBeNull();
    expect(cleanBbox(['0', 0, 1, 1])).toBeNull();
  });

  it('accepts a point-sized box', () => {
    expect(cleanBbox([1, 2, 1, 2])).toEqual([1, 2, 1, 2]);
  });
});
