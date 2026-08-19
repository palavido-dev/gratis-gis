// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import {
  parseAggregateQuery,
  rejectUnknownAggregateParams,
} from './aggregate-params.js';

/**
 * The aggregate endpoint is what a dashboard number is computed from,
 * so the failure mode that matters is not "it errored" but "it
 * answered the wrong question confidently". Every case here pins a
 * refusal that keeps a wrong number off the screen.
 */
describe('parseAggregateQuery', () => {
  it('parses a bare count', () => {
    const p = parseAggregateQuery({ agg: 'count' });
    expect(p.aggs).toEqual([{ op: 'count', as: 'count' }]);
    expect(p.groupBy).toEqual([]);
  });

  it('parses repeated params and comma lists identically', () => {
    const repeated = parseAggregateQuery({
      agg: ['sum:acres', 'max:acres'],
      groupBy: ['county', 'status'],
    });
    const comma = parseAggregateQuery({
      agg: 'sum:acres,max:acres',
      groupBy: 'county,status',
    });
    expect(repeated).toEqual(comma);
    expect(repeated.aggs.map((a) => a.as)).toEqual([
      'sum:acres',
      'max:acres',
    ]);
    expect(repeated.groupBy).toEqual(['county', 'status']);
  });

  it('keys results by the spec so a caller never correlates by position', () => {
    // A widget reads values['sum:acres']; if keys were positional, a
    // reordered request would silently relabel the numbers.
    const p = parseAggregateQuery({ agg: 'avg:depth' });
    expect(p.aggs[0]!.as).toBe('avg:depth');
  });

  it('refuses an unknown aggregate op', () => {
    expect(() => parseAggregateQuery({ agg: 'median:x' })).toThrow(
      BadRequestException,
    );
  });

  it('refuses count with a field, rather than guessing which count', () => {
    // count(field) means "non-null count", a different question. We
    // implement count(*), so answering it would be a wrong answer.
    expect(() => parseAggregateQuery({ agg: 'count:acres' })).toThrow(
      /count does not take a field/,
    );
  });

  it('refuses a value aggregate with no field', () => {
    expect(() => parseAggregateQuery({ agg: 'sum' })).toThrow(
      /needs a field/,
    );
  });

  it('requires at least one aggregate', () => {
    expect(() => parseAggregateQuery({})).toThrow(/At least one agg/);
  });

  it('validates bbox shape and orientation', () => {
    expect(parseAggregateQuery({ agg: 'count', bbox: '-81,38,-79,40' }).bbox).toEqual(
      [-81, 38, -79, 40],
    );
    expect(() =>
      parseAggregateQuery({ agg: 'count', bbox: '1,2,3' }),
    ).toThrow(BadRequestException);
    expect(() =>
      parseAggregateQuery({ agg: 'count', bbox: '0,50,10,40' }),
    ).toThrow(/south is greater/);
  });

  it('validates limit', () => {
    expect(parseAggregateQuery({ agg: 'count', limit: '50' }).limit).toBe(50);
    expect(() =>
      parseAggregateQuery({ agg: 'count', limit: '0' }),
    ).toThrow(BadRequestException);
    expect(() =>
      parseAggregateQuery({ agg: 'count', limit: 'lots' }),
    ).toThrow(BadRequestException);
  });
});

describe('rejectUnknownAggregateParams', () => {
  it('accepts the declared set', () => {
    expect(() =>
      rejectUnknownAggregateParams(['agg', 'groupBy', 'bbox', 'limit', 'clip']),
    ).not.toThrow();
  });

  it('refuses an unimplemented filter by name rather than ignoring it', () => {
    // `where` is deliberately not implemented until the phase 2
    // filter widget. Ignoring it would render a filtered dashboard
    // showing unfiltered numbers, with nothing on screen to say so.
    expect(() =>
      rejectUnknownAggregateParams(['agg', 'where']),
    ).toThrow(/where/);
  });

  it('names every offender at once', () => {
    expect(() =>
      rejectUnknownAggregateParams(['agg', 'where', 'having']),
    ).toThrow(/where, having/);
  });
});
