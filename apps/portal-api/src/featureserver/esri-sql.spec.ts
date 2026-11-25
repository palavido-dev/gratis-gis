// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import { esriSchema } from './esri-fields.js';
import { compileWhere, orderBySql, parseOrderBy } from './esri-sql.js';
import { parseEsriWhere } from './esri-where.js';

const schema = esriSchema([
  { name: 'status', type: 'string', label: 'Status', nullable: true },
  { name: 'area', type: 'number', label: 'Area', nullable: true },
  { name: 'seen', type: 'date', label: 'Seen', nullable: true },
  { name: 'ok', type: 'boolean', label: 'OK', nullable: true },
  { name: 'tags', type: 'multi_select', label: 'Tags', nullable: true },
]);

function sql(where: string): { text: string; values: unknown[] } {
  const s = compileWhere(parseEsriWhere(where), schema);
  return { text: s.text.replace(/\s+/g, ' '), values: s.values };
}

describe('compileWhere', () => {
  it('binds every field name and value as a parameter', () => {
    const { text, values } = sql("status = 'x''; DROP TABLE item; --'");
    expect(text).toBe('((attrs->>$1) = $2)');
    expect(values).toEqual(['status', "x'; DROP TABLE item; --"]);
  });

  it('matches field names without regard to case', () => {
    expect(sql("STATUS <> 'a'").values[0]).toBe('status');
  });

  it('compares number fields as numbers and refuses text for them', () => {
    const { text, values } = sql('area >= 2');
    expect(text).toContain('double precision');
    expect(values).toContain(2);
    expect(() => sql("area = 'big'")).toThrow(BadRequestException);
  });

  it('maps ObjectID and GlobalID onto the row columns', () => {
    expect(sql('OBJECTID IN (3, 4)').text).toBe('(oid IN ($1,$2))');
    const g = sql("GlobalID = '{0193F2A4-0000-7000-8000-000000000001}'");
    expect(g.text).toBe('(entity = $1::uuid)');
    expect(g.values).toEqual(['0193f2a4-0000-7000-8000-000000000001']);
    expect(() => sql("GlobalID = 'nope'")).toThrow(BadRequestException);
    expect(sql('OBJECTID IS NULL').text).toBe('FALSE');
  });

  it('compares dates as timestamps', () => {
    const { text, values } = sql("seen < DATE '2026-02-01'");
    expect(text).toContain('::timestamptz');
    expect(values).toContain('2026-02-01T00:00:00.000Z');
    expect(() => sql("seen = 'soon'")).toThrow(BadRequestException);
  });

  it('applies UPPER() to the value too', () => {
    const { text, values } = sql("UPPER(status) = 'open'");
    expect(text).toBe('(upper((attrs->>$1)) = $2)');
    expect(values).toEqual(['status', 'OPEN']);
  });

  it('allows LIKE on text only', () => {
    expect(sql("status NOT LIKE 'a%'").text).toBe('((attrs->>$1) NOT LIKE $2)');
    expect(() => sql("area LIKE '1%'")).toThrow(BadRequestException);
  });

  it('allows only null tests on a multiple-choice field', () => {
    expect(sql('tags IS NULL').text).toContain("'[]'::jsonb");
    expect(() => sql("tags = 'a'")).toThrow(BadRequestException);
  });

  it('refuses an unknown field', () => {
    expect(() => sql('nope = 1')).toThrow(/no field named "nope"/);
  });
});

describe('orderBy', () => {
  it('sorts by the named fields, then ObjectID', () => {
    const terms = parseOrderBy('status DESC, area', schema);
    expect(orderBySql(terms).text.replace(/\s+/g, ' ')).toContain('DESC NULLS LAST');
    expect(orderBySql(terms).text).toMatch(/oid ASC$/);
    expect(orderBySql(parseOrderBy("OBJECTID DESC", schema)).text).toBe('oid DESC NULLS LAST');
  });

  it('refuses anything but field names', () => {
    expect(() => parseOrderBy('status; DROP', schema)).toThrow(BadRequestException);
    expect(() => parseOrderBy('random()', schema)).toThrow(BadRequestException);
  });
});
