// SPDX-License-Identifier: AGPL-3.0-or-later
import { matchesFilter } from '@gratis-gis/shared-types';
import {
  buildIdSelectionFilter,
  buildSelectionFilter,
  MAX_SELECTION_FILTER_CLAUSES,
} from './selection-filter';

const rows = (props: Array<Record<string, unknown>>) => props.map((properties) => ({ properties }));

describe('buildSelectionFilter', () => {
  const parcels = rows([
    { city: 'Riverside', owner: 'Ann', apn: 'A1' },
    { city: 'Riverside', owner: 'Bob', apn: 'A2' },
    { city: 'Corona', owner: 'Ann', apn: 'A3' },
  ]);

  it('does not filter on a field other loaded rows share', () => {
    // One selected row used to make any non-empty field "unique":
    // city == "Riverside" matched every Riverside parcel.
    const out = buildSelectionFilter(['city', 'owner', 'apn'], parcels, new Set([0]), 1);
    expect(out).toEqual({
      ok: true,
      filter: { combinator: 'any', clauses: [{ field: 'apn', op: '==', value: 'A1' }] },
    });
  });

  it('skips an id-named field that is not unique', () => {
    const data = rows([{ id: 1, apn: 'A1' }, { id: 1, apn: 'A2' }]);
    const out = buildSelectionFilter(['id', 'apn'], data, new Set([1]), 1);
    expect(out.ok && out.filter.clauses[0]!.field).toBe('apn');
  });

  it('refuses when no field tells the selection apart', () => {
    const data = rows([{ city: 'X' }, { city: 'X' }]);
    expect(buildSelectionFilter(['city'], data, new Set([0]), 1)).toEqual({
      ok: false,
      reason: 'no-id-field',
    });
  });

  it('refuses more rows than the server accepts in one filter', () => {
    const many = rows(Array.from({ length: 30 }, (_, i) => ({ apn: `A${i}` })));
    const sel = new Set(Array.from({ length: MAX_SELECTION_FILTER_CLAUSES + 1 }, (_, i) => i));
    expect(buildSelectionFilter(['apn'], many, sel, sel.size)).toEqual({
      ok: false,
      reason: 'too-many',
    });
  });

  it('refuses when selected rows are not on the loaded page', () => {
    expect(buildSelectionFilter(['apn'], parcels, new Set([0]), 2)).toEqual({
      ok: false,
      reason: 'not-loaded',
    });
  });
});

// Review 37-4: a v3 layer keys rows by _global_id, so the selection
// becomes one exact id list, whatever page the rows are on.
describe('buildIdSelectionFilter', () => {
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';

  it('names exactly the selected features', () => {
    const out = buildIdSelectionFilter([a, b]);
    expect(out).toEqual({
      ok: true,
      filter: {
        combinator: 'all',
        clauses: [{ field: '_global_id', op: 'in', value: `${a},${b}` }],
      },
    });
    if (!out?.ok) throw new Error('expected a filter');
    expect(matchesFilter({ _global_id: a, city: 'Riverside' }, out.filter)).toBe(true);
    expect(
      matchesFilter(
        { _global_id: '33333333-3333-4333-8333-333333333333', city: 'Riverside' },
        out.filter,
      ),
    ).toBe(false);
  });

  it('leaves position-keyed layers to the id-field path', () => {
    expect(buildIdSelectionFilter([0, 3])).toBeNull();
    expect(buildIdSelectionFilter([a, 'not-an-id'])).toBeNull();
    expect(buildIdSelectionFilter([])).toBeNull();
  });

  it('refuses more ids than one filter may list', () => {
    const many = Array.from({ length: 1001 }, (_, i) =>
      `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
    );
    expect(buildIdSelectionFilter(many)).toEqual({ ok: false, reason: 'too-many' });
  });
});
