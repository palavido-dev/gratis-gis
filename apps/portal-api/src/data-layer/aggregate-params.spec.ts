// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import {
  parseAggregateQuery,
  parseVia,
  parseWhere,
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

/**
 * `where` is what makes a chart click filter the rest of the page, so
 * a malformed one has to fail loudly. Every case here pins a refusal
 * that stops a filtered dashboard from showing an unfiltered number.
 */
describe('parseWhere', () => {
  it('is absent when the parameter is', () => {
    expect(parseWhere(undefined)).toBeUndefined();
    expect(parseWhere('')).toBeUndefined();
  });

  it('parses a single equality and defaults the combinator to all', () => {
    const f = parseWhere(
      JSON.stringify({ clauses: [{ field: 'event_type', op: '==', value: 'Heavy Snow' }] }),
    );
    expect(f).toEqual({
      combinator: 'all',
      clauses: [{ field: 'event_type', op: '==', value: 'Heavy Snow' }],
    });
  });

  it('keeps values that would break a punctuated encoding', () => {
    // The reason the transport is JSON rather than field:op:value.
    // These are real category names and a real timestamp, and every
    // separator character appears inside one of them.
    const f = parseWhere(
      JSON.stringify({
        combinator: 'any',
        clauses: [
          { field: 'event_type', op: '==', value: 'Cold/Wind Chill' },
          { field: 'begin', op: '>=', value: '1' },
          { field: 'note', op: 'contains', value: 'a,b:c' },
        ],
      }),
    );
    expect(f?.clauses[0]!.value).toBe('Cold/Wind Chill');
    expect(f?.clauses[2]!.value).toBe('a,b:c');
    expect(f?.combinator).toBe('any');
  });

  it('drops the value requirement only for the null checks', () => {
    const f = parseWhere(
      JSON.stringify({ clauses: [{ field: 'rating', op: 'is-null' }] }),
    );
    expect(f?.clauses[0]).toEqual({ field: 'rating', op: 'is-null', value: '' });
    expect(() =>
      parseWhere(JSON.stringify({ clauses: [{ field: 'a', op: '==' }] })),
    ).toThrow(BadRequestException);
  });

  it('refuses a non-numeric value for a numeric comparison', () => {
    // Postgres accepts "abc" as the float NaN, which sorts above
    // everything: "> abc" would match nothing and "< abc" would match
    // the whole layer, both silently.
    expect(() =>
      parseWhere(JSON.stringify({ clauses: [{ field: 'len', op: '>', value: 'abc' }] })),
    ).toThrow(/must be a number/);
    expect(
      parseWhere(JSON.stringify({ clauses: [{ field: 'len', op: '>', value: '12.5' }] })),
    ).toBeTruthy();
  });

  it('refuses an unknown operator instead of ignoring the clause', () => {
    expect(() =>
      parseWhere(JSON.stringify({ clauses: [{ field: 'a', op: 'like', value: 'b' }] })),
    ).toThrow(BadRequestException);
  });

  it('refuses an empty clause list rather than guessing', () => {
    // Ambiguous between "match everything" and "I built my filter
    // wrong", and the two differ by the entire dataset.
    expect(() => parseWhere(JSON.stringify({ clauses: [] }))).toThrow(
      /omit where/,
    );
  });

  it('refuses malformed JSON, a non-object, and a repeated parameter', () => {
    expect(() => parseWhere('not json')).toThrow(BadRequestException);
    expect(() => parseWhere('[1,2]')).toThrow(/clauses/);
    expect(() => parseWhere(['{}', '{}'])).toThrow(/once/);
  });

  it('caps the clause count', () => {
    const many = {
      clauses: Array.from({ length: 21 }, (_, i) => ({
        field: `f${i}`,
        op: '==',
        value: 'x',
      })),
    };
    expect(() => parseWhere(JSON.stringify(many))).toThrow(/at most/);
  });

  it('flows through parseAggregateQuery', () => {
    const p = parseAggregateQuery({
      agg: 'count',
      groupBy: 'month',
      where: JSON.stringify({
        clauses: [{ field: 'event_type', op: '==', value: 'Flood' }],
      }),
    });
    expect(p.where?.clauses).toHaveLength(1);
  });
});

/**
 * `via` reads a layer the request never named in its path, so its
 * parsing is the first of two gates; the second is the controller's
 * read check on that parent, which no parser can stand in for.
 */
describe('parseVia', () => {
  const ok = {
    myField: 'well_id',
    parentField: 'well_id',
    parentItemId: 'item-parent',
    parentLayerId: 'wells',
  };

  it('is absent when the parameter is', () => {
    expect(parseVia(undefined)).toBeUndefined();
    expect(parseVia('')).toBeUndefined();
  });

  it('parses the four required fields', () => {
    expect(parseVia(JSON.stringify(ok))).toEqual(ok);
  });

  it('carries the parent scope through', () => {
    const f = parseVia(
      JSON.stringify({
        ...ok,
        parentBbox: '-81,38,-79,40',
        parentWhere: {
          clauses: [{ field: 'status', op: '==', value: 'Active' }],
        },
      }),
    );
    expect(f?.parentBbox).toEqual([-81, 38, -79, 40]);
    expect(f?.parentWhere?.clauses).toHaveLength(1);
  });

  it('refuses a missing or empty required field', () => {
    for (const key of [
      'myField',
      'parentField',
      'parentItemId',
      'parentLayerId',
    ]) {
      const bad = { ...ok, [key]: '' };
      expect(() => parseVia(JSON.stringify(bad))).toThrow(
        new RegExp(key),
      );
      const missing = { ...ok } as Record<string, unknown>;
      delete missing[key];
      expect(() => parseVia(JSON.stringify(missing))).toThrow(
        new RegExp(key),
      );
    }
  });

  it('refuses a nested via rather than walking a chain', () => {
    // A chain is where a hand-edited item turns into an unbounded
    // query, so it is refused by name instead of depth-counted.
    expect(() =>
      parseVia(JSON.stringify({ ...ok, via: { ...ok } })),
    ).toThrow(/one hop/);
  });

  it('refuses malformed JSON, a non-object, and a repeated parameter', () => {
    expect(() => parseVia('not json')).toThrow(BadRequestException);
    expect(() => parseVia('42')).toThrow(/must be a JSON object/);
    expect(() => parseVia(['{}', '{}'])).toThrow(/once/);
  });

  it('refuses a malformed parent bbox', () => {
    expect(() =>
      parseVia(JSON.stringify({ ...ok, parentBbox: '1,2,3' })),
    ).toThrow(/via.parentBbox/);
    expect(() =>
      parseVia(JSON.stringify({ ...ok, parentBbox: '0,50,10,40' })),
    ).toThrow(/south is greater/);
  });

  it('flows through parseAggregateQuery', () => {
    const p = parseAggregateQuery({
      agg: 'count',
      via: JSON.stringify(ok),
    });
    expect(p.via?.parentLayerId).toBe('wells');
  });
});


describe('rejectUnknownAggregateParams', () => {
  it('accepts the declared set', () => {
    expect(() =>
      rejectUnknownAggregateParams(['agg', 'groupBy', 'bbox', 'limit', 'clip']),
    ).not.toThrow();
  });

  it('accepts where and via, which the data-source model implements', () => {
    expect(() =>
      rejectUnknownAggregateParams(['agg', 'where', 'via']),
    ).not.toThrow();
  });

  it('refuses an unimplemented filter by name rather than ignoring it', () => {
    // Ignoring an unsupported filter renders a filtered dashboard
    // showing unfiltered numbers, with nothing on screen to say so.
    expect(() =>
      rejectUnknownAggregateParams(['agg', 'having']),
    ).toThrow(/having/);
  });

  it('names every offender at once', () => {
    expect(() =>
      rejectUnknownAggregateParams(['agg', 'having', 'orderBy']),
    ).toThrow(/having, orderBy/);
  });
});
