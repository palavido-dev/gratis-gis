// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Both county cell regexes were quadratic on a long whitespace run;
// one CSV cell held the API for minutes. They are string code now.

import { normalizeCountyName, parseCountyCell } from './csv-geomatch.js';

describe('county cell parsing', () => {
  it('splits name and state on the last comma', () => {
    expect(parseCountyCell('Travis, TX')).toEqual({ name: 'Travis', state: 'TX' });
    expect(parseCountyCell('Travis County, Texas')).toEqual({ name: 'Travis County', state: 'Texas' });
    expect(parseCountyCell('Travis')).toEqual({ name: 'Travis', state: null });
    expect(parseCountyCell('A, B, 12')).toEqual({ name: 'A, B, 12', state: null });
  });

  it('strips county-type suffixes', () => {
    expect(normalizeCountyName('Travis County')).toBe(normalizeCountyName('Travis'));
    expect(normalizeCountyName('Juneau City and Borough')).toBe(normalizeCountyName('Juneau'));
    expect(normalizeCountyName('Orleans  Parish')).toBe(normalizeCountyName('Orleans'));
    expect(normalizeCountyName('County')).toBe(normalizeCountyName('County'));
  });

  it('is fast on a hostile cell', () => {
    const cell = 'a' + ' '.repeat(1_000_000) + 'b';
    const t = Date.now();
    parseCountyCell(cell);
    normalizeCountyName(cell);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
