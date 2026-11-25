// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import { parseEsriWhere } from './esri-where.js';

describe('parseEsriWhere', () => {
  it('treats an empty clause and 1=1 as every feature', () => {
    expect(parseEsriWhere(undefined)).toEqual({ t: 'const', value: true });
    expect(parseEsriWhere('  ')).toEqual({ t: 'const', value: true });
    expect(parseEsriWhere('1=1')).toEqual({ t: 'const', value: true });
    expect(parseEsriWhere('1=0')).toEqual({ t: 'const', value: false });
  });

  it('reads comparisons, AND, OR, NOT and parentheses with the usual precedence', () => {
    expect(parseEsriWhere("STATUS = 'Open' AND (AREA > 5 OR NOT AREA <= -2.5)")).toEqual({
      t: 'and',
      items: [
        { t: 'cmp', op: '=', field: { name: 'STATUS' }, value: { kind: 'string', value: 'Open' } },
        {
          t: 'or',
          items: [
            { t: 'cmp', op: '>', field: { name: 'AREA' }, value: { kind: 'number', value: 5 } },
            {
              t: 'not',
              item: { t: 'cmp', op: '<=', field: { name: 'AREA' }, value: { kind: 'number', value: -2.5 } },
            },
          ],
        },
      ],
    });
  });

  it('reads IN, NOT IN, BETWEEN, LIKE with ESCAPE, IS [NOT] NULL and UPPER()', () => {
    expect(parseEsriWhere('OBJECTID IN (1, 2,3)')).toMatchObject({ t: 'in', negated: false, values: [{ value: 1 }, { value: 2 }, { value: 3 }] });
    expect(parseEsriWhere("type NOT IN ('a')")).toMatchObject({ t: 'in', negated: true });
    expect(parseEsriWhere('n BETWEEN 1 AND 4')).toMatchObject({ t: 'between', lo: { value: 1 }, hi: { value: 4 } });
    expect(parseEsriWhere("UPPER(name) LIKE '%MAIN!_ST%' ESCAPE '!'")).toEqual({
      t: 'like',
      field: { name: 'name', fn: 'upper' },
      pattern: '%MAIN!_ST%',
      escape: '!',
      negated: false,
    });
    expect(parseEsriWhere('note IS NOT NULL')).toEqual({ t: 'null', field: { name: 'note' }, negated: true });
  });

  it('reads DATE and TIMESTAMP literals, doubled quotes and quoted names', () => {
    expect(parseEsriWhere("seen >= DATE '2026-01-02'")).toMatchObject({ value: { kind: 'date', value: '2026-01-02' } });
    expect(parseEsriWhere("seen < timestamp '2026-01-02 10:00:00'")).toMatchObject({ value: { kind: 'date' } });
    expect(parseEsriWhere("owner = 'O''Brien'")).toMatchObject({ value: { value: "O'Brien" } });
    expect(parseEsriWhere('"Owner Name" = \'x\'')).toMatchObject({ field: { name: 'Owner Name' } });
  });

  it('flips a value on the left', () => {
    expect(parseEsriWhere('5 < AREA')).toMatchObject({ t: 'cmp', op: '>', field: { name: 'AREA' } });
  });

  it.each([
    ["name = 'unterminated"],
    ['a = b'],
    ['a = NULL'],
    ['DROP TABLE x'],
    ['a = 1; DELETE FROM item'],
    ['a = (SELECT 1)'],
    ['a IN ()'],
    ['f(a) = 1'],
    ["1 = 'a'"],
  ])('refuses %s', (where) => {
    expect(() => parseEsriWhere(where)).toThrow(BadRequestException);
  });

  it('refuses a clause nested past the limit', () => {
    expect(() => parseEsriWhere(`${'('.repeat(60)}a = 1${')'.repeat(60)}`)).toThrow(BadRequestException);
  });
});
