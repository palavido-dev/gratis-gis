// SPDX-License-Identifier: AGPL-3.0-or-later
import { combineFilter, timeBinsColorExpression } from './map-layer-expressions';

describe('map layer expressions', () => {
  it('adds the attribute filter to the geometry filter', () => {
    const geom = ['==', ['geometry-type'], 'Point'];
    expect(combineFilter(geom, null)).toEqual(geom);
    expect(
      combineFilter(geom, {
        combinator: 'all',
        clauses: [{ field: 'status', op: '==', value: 'Active' }],
      } as never),
    ).toEqual([
      'all',
      geom,
      [
        'all',
        ['all', ['!=', ['get', 'status'], null], ['==', ['to-string', ['get', 'status']], 'Active']],
      ],
    ]);
  });

  it('builds time bins as a case chain, never a string step', () => {
    const expr = timeBinsColorExpression({
      kind: 'time-bins',
      field: 'inspected',
      boundaries: ['2026-01-01', '2026-06-01'],
      bins: [{ color: '#111' }, { color: '#222' }, { color: '#333' }],
      defaultColor: '#999',
    } as never);
    expect(expr?.[0]).toBe('case');
    expect(JSON.stringify(expr)).not.toContain('"step"');
    expect(expr?.[expr.length - 1]).toBe('#333');
  });

  it('returns null for a half-built time-bins renderer', () => {
    expect(
      timeBinsColorExpression({
        kind: 'time-bins',
        field: 'inspected',
        boundaries: ['2026-01-01'],
        bins: [{ color: '#111' }],
        defaultColor: '#999',
      } as never),
    ).toBeNull();
  });
});
