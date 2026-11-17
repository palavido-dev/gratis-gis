// SPDX-License-Identifier: AGPL-3.0-or-later
import { filterWithSourceIndex, rowIndexForKey, rowSelectionKey } from './table-row-keys';

describe('table row keys', () => {
  // Ten source features; the layer filter keeps positions 5 to 9.
  const source = Array.from({ length: 10 }, (_, i) => ({ properties: { n: i } }));
  const kept = filterWithSourceIndex(source, (f) => f.properties.n >= 5);

  it('keys a filtered row by its position in the source, as the map does', () => {
    expect(rowSelectionKey(kept.items, 0, kept.srcIdx)).toBe(5);
    expect(rowSelectionKey(kept.items, 2, kept.srcIdx)).toBe(7);
  });

  it('finds the row for a key the map stored', () => {
    expect(rowIndexForKey(kept.items, 7, kept.srcIdx)).toBe(2);
    // A source feature the filter hides has no row.
    expect(rowIndexForKey(kept.items, 2, kept.srcIdx)).toBe(-1);
  });

  it('keeps positions as keys when nothing is filtered', () => {
    expect(rowSelectionKey(source, 3, null)).toBe(3);
    expect(rowIndexForKey(source, 3, null)).toBe(3);
    expect(rowIndexForKey(source, 10, null)).toBe(-1);
  });

  it('prefers a global id over any position', () => {
    const rows = [{ properties: { _global_id: 'g-1' } }];
    expect(rowSelectionKey(rows, 0, [4])).toBe('g-1');
    expect(rowIndexForKey(rows, 'g-1', [4])).toBe(0);
  });
});
