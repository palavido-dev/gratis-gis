// SPDX-License-Identifier: AGPL-3.0-or-later
import { parseRegionTiles, readAreas } from './offline-package.worker.js';

/**
 * The size guard is only as good as this parse. If the upstream CLI
 * changes its log wording, the guard has to fail loudly rather than
 * quietly reading zero and waving a continent through.
 */
describe('parseRegionTiles', () => {
  /** Verbatim from `pmtiles extract --dry-run` on 2026-08-24. */
  const REAL_OUTPUT = [
    '2026/08/24 16:38:51 extract.go:373: fetching 6 dirs, 6 chunks, 6 requests',
    '2026/08/24 16:38:56 extract.go:413: Region tiles 1683, result tile entries 1683',
    '2026/08/24 16:38:56 extract.go:422: fetching 1683 tiles, 76 chunks, 45 requests',
    '2026/08/24 16:38:56 extract.go:578: Completed in 5.63s with 4 download threads.',
    '2026/08/24 16:38:56 extract.go:583: Extract required 54 total requests.',
    '2026/08/24 16:38:56 extract.go:584: Extract transferred 9.0 MB for an archive size of 8.6 MB',
  ].join('\n');

  it('reads the count out of real CLI output', () => {
    expect(parseRegionTiles(REAL_OUTPUT)).toBe(1683);
  });

  it('takes the region count, not the other numbers on nearby lines', () => {
    // 'fetching 6 dirs' comes first and 'fetching 1683 tiles' comes
    // after; a looser pattern would happily return 6.
    expect(parseRegionTiles(REAL_OUTPUT)).not.toBe(6);
  });

  it('handles a zero-coverage region', () => {
    expect(
      parseRegionTiles('extract.go:413: Region tiles 0, result tile entries 0'),
    ).toBe(0);
  });

  it('returns null when the line is absent', () => {
    // Distinct from 0 on purpose. Conflating them would turn "the
    // tool changed its output" into "this area is empty", and the
    // caller treats the latter as a buildable answer.
    expect(parseRegionTiles('some other output entirely')).toBeNull();
    expect(parseRegionTiles('')).toBeNull();
  });
});

describe('readAreas', () => {
  const good = {
    id: 'a1',
    name: 'North block',
    bbox: [-80, 38, -79, 39],
    minZoom: 0,
    maxZoom: 14,
  };

  it('reads areas off a data_collection', () => {
    expect(readAreas({ version: 1, offlineAreas: [good] })).toHaveLength(1);
  });

  it('tolerates every shape an older or hand-edited item can have', () => {
    expect(readAreas(null)).toEqual([]);
    expect(readAreas(undefined)).toEqual([]);
    expect(readAreas('nonsense')).toEqual([]);
    expect(readAreas({ version: 1 })).toEqual([]);
    expect(readAreas({ offlineAreas: 'not an array' })).toEqual([]);
  });

  it('drops entries that could not be built from', () => {
    const areas = readAreas({
      offlineAreas: [
        good,
        null,
        { id: 'no-bbox', name: 'x' },
        { name: 'no-id', bbox: [-80, 38, -79, 39] },
        { id: 'short-bbox', bbox: [-80, 38] },
      ],
    });
    expect(areas.map((a) => a.id)).toEqual(['a1']);
  });
});
