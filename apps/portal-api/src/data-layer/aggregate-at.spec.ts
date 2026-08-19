// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import { parseAggregateQuery } from './aggregate-params.js';

/**
 * The time-slider drives every data-bound widget on a page to one
 * instant. Before `at` reached this endpoint, scrubbing the slider
 * moved the map and the attribute table while the indicator and
 * chart beside them silently stayed at "now": three widgets agreeing
 * and one quietly disagreeing, with nothing on screen to say which
 * was which.
 */
describe('aggregate ?at= (bitemporal reads)', () => {
  it('parses an RFC 3339 instant', () => {
    const p = parseAggregateQuery({
      agg: 'count',
      at: '2026-07-01T00:00:00Z',
    });
    expect(p.asOf?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('refuses a malformed instant rather than silently reading now', () => {
    expect(() =>
      parseAggregateQuery({ agg: 'count', at: 'last tuesday' }),
    ).toThrow(BadRequestException);
  });

  it('is absent when not asked for, so the engine defaults to now', () => {
    expect(parseAggregateQuery({ agg: 'count' }).asOf).toBeUndefined();
  });
});
