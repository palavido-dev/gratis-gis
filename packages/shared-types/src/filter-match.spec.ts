// SPDX-License-Identifier: AGPL-3.0-or-later
import { matchesFilter } from './filter-match.js';
import type { MapLayerFilter } from './map.js';

/**
 * These cases exist to pin the JS evaluator to what the SQL and the
 * MapLibre expression already do, since a filter now has three
 * implementations and only one of them can be checked against a
 * database. Where a case looks surprising, the comment says which of
 * the other two it is agreeing with.
 */

const f = (
  clauses: MapLayerFilter['clauses'],
  combinator: 'all' | 'any' = 'all',
): MapLayerFilter => ({ combinator, clauses });

describe('matchesFilter: absent filter', () => {
  it('matches everything when the filter is missing or empty', () => {
    expect(matchesFilter({ a: 1 }, null)).toBe(true);
    expect(matchesFilter({ a: 1 }, undefined)).toBe(true);
    expect(matchesFilter({ a: 1 }, f([]))).toBe(true);
  });
});

describe('matchesFilter: equality', () => {
  it('compares on the text form, so 5 and "5" are one value', () => {
    // The engine reads attrs->>field, which is text. A filter authored
    // against a JSON number has to keep matching a layer that stored
    // the same value as a string.
    const filter = f([{ field: 'n', op: '==', value: '5' }]);
    expect(matchesFilter({ n: 5 }, filter)).toBe(true);
    expect(matchesFilter({ n: '5' }, filter)).toBe(true);
    expect(matchesFilter({ n: 6 }, filter)).toBe(false);
  });

  it('a missing value equals nothing', () => {
    const filter = f([{ field: 'status', op: '==', value: 'open' }]);
    expect(matchesFilter({}, filter)).toBe(false);
    expect(matchesFilter({ status: null }, filter)).toBe(false);
  });

  it('!= is TRUE for a missing value', () => {
    // SQL says this with IS DISTINCT FROM; a plain <> against NULL is
    // NULL and would drop the row. A reader asking for "not closed"
    // means to include the rows with nothing recorded.
    const filter = f([{ field: 'status', op: '!=', value: 'closed' }]);
    expect(matchesFilter({}, filter)).toBe(true);
    expect(matchesFilter({ status: null }, filter)).toBe(true);
    expect(matchesFilter({ status: 'open' }, filter)).toBe(true);
    expect(matchesFilter({ status: 'closed' }, filter)).toBe(false);
  });
});

describe('matchesFilter: numeric comparison', () => {
  const over = f([{ field: 'iron', op: '>=', value: '0.3' }]);

  it('compares numerically, not as text', () => {
    // "10" < "9" as strings; the whole point of these ops is that it
    // does not here.
    expect(matchesFilter({ iron: 10 }, over)).toBe(true);
    expect(matchesFilter({ iron: '10' }, over)).toBe(true);
    expect(matchesFilter({ iron: 0.29 }, over)).toBe(false);
  });

  it('is FALSE for a non-numeric value rather than coercing', () => {
    // pg_input_is_valid guards the SQL side; "n/a" >= 0.3 must not be
    // true just because the string sorts high.
    expect(matchesFilter({ iron: 'n/a' }, over)).toBe(false);
    expect(matchesFilter({ iron: '' }, over)).toBe(false);
    expect(matchesFilter({}, over)).toBe(false);
    expect(matchesFilter({ iron: null }, over)).toBe(false);
  });

  it('is FALSE when the CLAUSE value is not numeric', () => {
    const bad = f([{ field: 'iron', op: '>', value: 'lots' }]);
    expect(matchesFilter({ iron: 99 }, bad)).toBe(false);
  });

  it('handles the full set of orderings at the boundary', () => {
    const at = { v: 5 };
    expect(matchesFilter(at, f([{ field: 'v', op: '>', value: '5' }]))).toBe(
      false,
    );
    expect(matchesFilter(at, f([{ field: 'v', op: '>=', value: '5' }]))).toBe(
      true,
    );
    expect(matchesFilter(at, f([{ field: 'v', op: '<', value: '5' }]))).toBe(
      false,
    );
    expect(matchesFilter(at, f([{ field: 'v', op: '<=', value: '5' }]))).toBe(
      true,
    );
  });
});

describe('matchesFilter: contains and null tests', () => {
  it('contains is a plain substring test on the text form', () => {
    const filter = f([{ field: 'list', op: 'contains', value: 'Iron' }]);
    expect(matchesFilter({ list: 'Iron; Manganese' }, filter)).toBe(true);
    expect(matchesFilter({ list: 'Manganese' }, filter)).toBe(false);
    expect(matchesFilter({}, filter)).toBe(false);
  });

  it('does not treat the value as a pattern', () => {
    // The SQL side escapes LIKE metacharacters for exactly this.
    const filter = f([{ field: 'code', op: 'contains', value: '%' }]);
    expect(matchesFilter({ code: 'a%b' }, filter)).toBe(true);
    expect(matchesFilter({ code: 'ab' }, filter)).toBe(false);
  });

  it('is-null and is-not-null treat absent and null alike', () => {
    const isNull = f([{ field: 'x', op: 'is-null', value: '' }]);
    const notNull = f([{ field: 'x', op: 'is-not-null', value: '' }]);
    expect(matchesFilter({}, isNull)).toBe(true);
    expect(matchesFilter({ x: null }, isNull)).toBe(true);
    expect(matchesFilter({ x: '' }, isNull)).toBe(false);
    expect(matchesFilter({ x: 0 }, notNull)).toBe(true);
    expect(matchesFilter({}, notNull)).toBe(false);
  });

  it('an empty string is a value, not a null', () => {
    expect(
      matchesFilter({ x: '' }, f([{ field: 'x', op: '==', value: '' }])),
    ).toBe(true);
  });

  it('false and 0 are values, not absences', () => {
    expect(
      matchesFilter({ x: false }, f([{ field: 'x', op: '==', value: 'false' }])),
    ).toBe(true);
    expect(
      matchesFilter({ x: 0 }, f([{ field: 'x', op: 'is-not-null', value: '' }])),
    ).toBe(true);
  });
});

describe('matchesFilter: combinators', () => {
  const clauses: MapLayerFilter['clauses'] = [
    { field: 'a', op: '==', value: '1' },
    { field: 'b', op: '==', value: '2' },
  ];

  it('all means AND', () => {
    expect(matchesFilter({ a: 1, b: 2 }, f(clauses, 'all'))).toBe(true);
    expect(matchesFilter({ a: 1, b: 9 }, f(clauses, 'all'))).toBe(false);
  });

  it('any means OR', () => {
    expect(matchesFilter({ a: 1, b: 9 }, f(clauses, 'any'))).toBe(true);
    expect(matchesFilter({ a: 9, b: 9 }, f(clauses, 'any'))).toBe(false);
  });
});

describe('matchesFilter: degenerate clauses', () => {
  it('a clause with no field is ignored, not treated as no match', () => {
    // The filter editor writes an empty row the moment the user adds a
    // clause. Dropping every feature while they pick a field would
    // make the map go blank mid-edit.
    expect(matchesFilter({ a: 1 }, f([{ field: '', op: '==', value: 'x' }]))).toBe(
      true,
    );
  });

  it('an operator this build does not know reads as absent', () => {
    const filter = {
      combinator: 'all',
      clauses: [{ field: 'a', op: 'sounds-like', value: 'x' }],
    } as unknown as MapLayerFilter;
    // Better to show a row the author meant to hide than to blank the
    // table after an older client saves a newer operator.
    expect(matchesFilter({ a: 1 }, filter)).toBe(true);
  });
});
