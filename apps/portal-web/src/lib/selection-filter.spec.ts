// SPDX-License-Identifier: AGPL-3.0-or-later
import { buildSelectionFilter, MAX_SELECTION_FILTER_CLAUSES } from './selection-filter';

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
