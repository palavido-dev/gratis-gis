// SPDX-License-Identifier: AGPL-3.0-or-later
import { quoteSqlIdent, sanitizeFieldName, uniqueFieldNames } from './analyze-save-columns';

describe('analyze save column names', () => {
  it('sanitizes DuckDB result names into schema field names', () => {
    expect(sanitizeFieldName('count_star()')).toBe('count_star');
    expect(sanitizeFieldName('avg(acres)')).toBe('avg_acres');
    expect(sanitizeFieldName('Total')).toBe('total');
    expect(sanitizeFieldName('2020')).toBe('f_2020');
    expect(sanitizeFieldName('()')).toBe('field');
  });

  it('keeps every column when two sanitize to the same name', () => {
    expect(uniqueFieldNames(['Total', 'total', 'TOTAL'])).toEqual(['total', 'total_2', 'total_3']);
    expect(uniqueFieldNames(['geom'], ['geom'])).toEqual(['geom_2']);
  });

  it('quotes identifiers with embedded quotes', () => {
    expect(quoteSqlIdent('a"b')).toBe('"a""b"');
  });
});
