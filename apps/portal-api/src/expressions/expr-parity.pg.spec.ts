// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The expression language has two runtimes: SQL on the server and
// JavaScript in the browser and the offline field app. This suite runs
// every case through both and requires the same answer, so a preview
// in the builder, a label on the map and a value written by Calculate
// Field cannot disagree.
//
// Skipped unless TEST_DATABASE_URL is set (see data-layer.pg.spec.ts).
// It installs the gg_expr_* functions from their migration first.
// Geometry cases run only where PostGIS is installed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import {
  compileExpressionSql,
  evaluateExpressionValue,
  type FieldRef,
} from '@gratis-gis/shared-types';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error('REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset');
}

const FIELDS: FieldRef[] = [
  { name: 'n', type: 'number' },
  { name: 'm', type: 'number' },
  { name: 't', type: 'string' },
  { name: 'd', type: 'date' },
  { name: 'e', type: 'date' },
  { name: 'b', type: 'boolean' },
  { name: 'l', type: 'list' },
  { name: 'u', type: 'unknown' },
];

const ROWS: Array<Record<string, unknown>> = [
  {},
  { n: 12.5, m: 4, t: 'Baker Street', d: '2024-02-29', e: '2024-01-31T10:15:00Z', b: true, l: ['oak', 'pine'], u: '42' },
  { n: -2.5, m: 0, t: '', d: '2024-05-01T10:00:00+02:00', e: '2023-12-31', b: 'no', l: [], u: 'n/a' },
  { n: '7', m: 'x', t: 'héllo wörld', d: 'garbage', e: '2021-01-03', b: null, l: 'single', u: true },
  { n: 1e15, m: 3, t: '  padded  ', d: '1999-12-31T23:59:59Z', e: '2000-03-31', b: false, l: ['a', null, 5], u: '2024-01-01' },
  { n: 0.1, m: 0.2, t: "O'Brien_%", d: '2020-01-31', e: '2020-02-29T12:00:00Z', b: 't', l: ['b'], u: '' },
];

const CASES: string[] = [
  // arithmetic, null handling
  '{{n}} + {{m}}',
  '{{n}} - {{m}} * 2',
  '{{n}} / {{m}}',
  '{{n}} % {{m}}',
  '-{{n}}',
  '{{u}} + 1',
  '{{n}} + {{u}}',
  "{{t}} + '!'",
  "{{t}} ~~ {{n}}",
  "'a' + {{n}}",
  // comparisons
  '{{n}} > {{m}}',
  '{{n}} == {{m}}',
  '{{n}} != {{m}}',
  "{{t}} == 'Baker Street'",
  "{{t}} != 'Baker Street'",
  "{{t}} < 'C'",
  "{{t}} >= 'a'",
  '{{n}} == null',
  '{{t}} != null',
  "{{u}} == 42",
  "{{u}} > '30'",
  "{{n}} == '12.5'",
  '{{b}} == true',
  "{{b}} == 'yes'",
  "{{d}} > '2024-01-01'",
  '{{d}} == {{e}}',
  "{{d}} < {{e}}",
  "{{l}} == 'b'",
  "{{l}} == ['oak', 'pine']",
  // logic
  '{{b}} and {{n}} > 0',
  'not {{b}}',
  '{{b}} or {{n}} is null',
  'not ({{n}} > 1)',
  // in, between, like, is null
  "{{t}} in ('Baker Street', '')",
  "{{t}} not in ('Baker Street', '')",
  '{{n}} in (12.5, 7, null)',
  "'oak' in {{l}}",
  "'oak' not in {{l}}",
  '{{n}} between {{m}} and 20',
  '{{n}} not between 0 and 10',
  "{{d}} between '2020-01-01' and '2024-03-01'",
  "{{t}} like 'B%'",
  "{{t}} ilike '%STREET'",
  "{{t}} like '%\\_%'",
  "{{t}} not like '_'",
  '{{d}} is null',
  '{{l}} is not null',
  // case, if, when, decode, coalesce, is_empty
  "case when {{n}} > 10 then 'big' when {{n}} > 0 then 'small' else 'none' end",
  "case {{m}} when 4 then 'four' when 0 then 'zero' end",
  "if({{b}}, {{n}}, {{m}})",
  "if({{n}} > 0, {{t}}, {{n}})",
  "when({{n}} > 10, 'a', {{n}} > 0, 'b', 'c')",
  "decode({{m}}, 4, 'four', 3, 'three', 'other')",
  "decode({{t}}, '', 'blank', null, 'missing', 'set')",
  "coalesce({{n}}, {{m}}, -1)",
  "coalesce({{t}}, 'none')",
  "coalesce({{d}}, {{e}})",
  'is_empty({{t}})',
  'is_empty({{l}})',
  'is_empty({{n}})',
  // text
  'upper({{t}})',
  'lower({{t}})',
  'proper({{t}})',
  'trim({{t}})',
  'ltrim({{t}}) ~~ "|"',
  'rtrim({{t}}) ~~ "|"',
  'length({{t}})',
  'left({{t}}, 3)',
  'right({{t}}, 3)',
  'left({{t}}, -1)',
  'substr({{t}}, 2)',
  'substr({{t}}, 2, 3)',
  'substr({{t}}, -1, 3)',
  "index_of({{t}}, 'e')",
  "replace({{t}}, 'e', 'E')",
  "replace({{t}}, '', 'x')",
  "concat({{t}}, {{n}}, {{d}}, {{b}}, {{l}})",
  "contains({{t}}, 'STREET')",
  "contains({{l}}, 'oak')",
  "starts_with({{t}}, 'Ba')",
  "ends_with({{t}}, 'et')",
  "pad_left({{t}}, 14, '*-')",
  "pad_right(text({{m}}), 3, '0')",
  "split_part({{t}}, ' ', 2)",
  "split_part({{t}}, ' ', -1)",
  'format_number({{n}}, 2)',
  'format_number({{n}} * 1000, 0)',
  'format_number(-1234.565, 2)',
  // math
  'abs({{n}})',
  'round({{n}})',
  'round({{n}}, 1)',
  'round(1.005, 2)',
  'round(-2.5)',
  'round(123456.789, -2)',
  'floor({{n}})',
  'ceil({{n}})',
  'trunc({{n}})',
  'sign({{n}})',
  'sqrt({{n}})',
  'power({{n}}, {{m}})',
  'power(-8, 1 / 3)',
  'exp({{m}})',
  'ln({{n}})',
  'log10({{n}})',
  'round(pi(), 6)',
  'min({{n}}, {{m}}, 3)',
  'max({{n}}, {{m}})',
  'clamp({{n}}, 0, 10)',
  // conversion
  'number({{t}})',
  'number({{u}})',
  'number({{b}})',
  'number({{d}})',
  'text({{n}})',
  'text({{n}} / 3)',
  'text({{d}})',
  'text({{b}})',
  'text({{l}})',
  'boolean({{u}})',
  'boolean({{n}})',
  'to_date({{u}})',
  // dates
  "date_add({{d}}, 1, 'years')",
  "date_add({{d}}, 1, 'months')",
  "date_add({{d}}, -1, 'quarters')",
  "date_add({{d}}, 1.5, 'days')",
  "date_add({{d}}, 90, 'minutes')",
  "date_add({{d}}, {{m}}, 'weeks')",
  "date_diff({{d}}, {{e}}, 'days')",
  "date_diff({{d}}, {{e}}, 'hours')",
  "date_diff({{d}}, {{e}}, 'months')",
  "date_diff({{e}}, {{d}}, 'months')",
  "date_diff({{d}}, {{e}}, 'years')",
  "date_diff({{d}}, {{e}}, 'quarters')",
  "start_of({{e}}, 'months')",
  "start_of({{e}}, 'weeks')",
  "start_of({{e}}, 'quarters')",
  "start_of({{e}}, 'hours')",
  'year({{e}})',
  'quarter({{e}})',
  'month({{e}})',
  'day({{e}})',
  'hour({{e}})',
  'minute({{e}})',
  'second({{e}})',
  'weekday({{e}})',
  'day_of_year({{e}})',
  'week({{e}})',
  "format_date({{e}}, 'YYYY-MM-DD HH:mm:ss')",
  "format_date({{e}}, 'dddd, MMMM D, YYYY [at] h:mm A')",
  "format_date({{e}}, 'ddd MMM DD YY hh H M')",
  'date(2024, 2, 29)',
  'date(2023, 2, 29)',
  'date(2024, 13, 1)',
  "date('2024-07-04')",
  // lists
  'count({{l}})',
  "join({{l}}, '/')",
  "any_of({{l}}, 'oak', 'b')",
  "all_of({{l}}, 'oak', 'pine')",
  "['x', {{t}}, null]",
];

/** pg values in the form the JavaScript evaluator returns. */
function normalize(v: unknown, type: string): unknown {
  if (v === null || v === undefined) return null;
  if (type === 'date' && v instanceof Date) {
    // Rendered by the database itself (gg_expr_ts_text) below.
    return v;
  }
  return v;
}

d('expression SQL and JavaScript agree', () => {
  let db: Client;
  let hasPostgis = false;

  beforeAll(async () => {
    db = new Client({ connectionString: TEST_URL });
    await db.connect();
    const sql = readFileSync(
      join(__dirname, '../../prisma/migrations/20261124090000_expression_functions/migration.sql'),
      'utf8',
    );
    await db.query(sql);
    const r = await db.query("SELECT 1 FROM pg_available_extensions WHERE name = 'postgis'");
    if (r.rowCount) {
      await db.query('CREATE EXTENSION IF NOT EXISTS postgis');
      hasPostgis = true;
    }
  });

  afterAll(async () => {
    await db?.end();
  });

  async function viaSql(src: string, row: Record<string, unknown>, geometry?: unknown): Promise<unknown> {
    const compiled = compileExpressionSql(src, {
      fields: FIELDS,
      row: { propertiesSql: 'r.p', geomSql: 'r.g' },
      paramOffset: 2,
      timeZone: 'America/Los_Angeles',
    });
    // Dates come back through the database's own text form, which is
    // what every consumer stores; lists stay arrays.
    const out =
      compiled.type === 'date'
        ? `gg_expr_ts_text(${compiled.sql})`
        : compiled.sql;
    const geom = hasPostgis ? 'ST_SetSRID(ST_GeomFromGeoJSON($2::text), 4326)' : '$2::text';
    const res = await db.query(
      `SELECT ${out} AS v FROM (SELECT $1::jsonb AS p, ${geom} AS g) r`,
      [JSON.stringify(row), geometry ? JSON.stringify(geometry) : null, ...compiled.params],
    );
    return normalize(res.rows[0].v, compiled.type);
  }

  function viaJs(src: string, row: Record<string, unknown>, geometry?: unknown): unknown {
    return evaluateExpressionValue(src, {
      fields: FIELDS,
      properties: row,
      geometry: geometry ?? null,
      timeZone: 'America/Los_Angeles',
    });
  }

  it.each(CASES)('%s', async (src) => {
    for (const row of ROWS) {
      const js = viaJs(src, row);
      const sql = await viaSql(src, row);
      if (typeof js === 'number' && typeof sql === 'number') {
        expect({ src, row, v: sql }).toEqual({ src, row, v: expect.closeTo(js, 9) });
      } else {
        expect({ src, row, v: sql }).toEqual({ src, row, v: js });
      }
    }
  });

  it('agrees on today() in a time zone', async () => {
    expect(await viaSql('text(today())', {})).toBe(viaJs('text(today())', {}));
  });

  const GEOMS = [
    { type: 'Point', coordinates: [-117.2, 33.9] },
    { type: 'LineString', coordinates: [[-117.2, 33.9], [-117.1, 34.0], [-117.0, 34.0]] },
    {
      type: 'Polygon',
      coordinates: [
        [[-117.2, 33.9], [-117.1, 33.9], [-117.1, 34.0], [-117.2, 34.0], [-117.2, 33.9]],
        [[-117.18, 33.92], [-117.18, 33.95], [-117.15, 33.95], [-117.15, 33.92], [-117.18, 33.92]],
      ],
    },
    {
      type: 'MultiPolygon',
      coordinates: [
        [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
        [[[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]],
      ],
    },
  ];
  const GEOM_CASES = [
    "area($feature, 'acres')",
    'area($feature)',
    "length($feature, 'miles')",
    'length($feature)',
    'x($feature)',
    'y($feature)',
    'geometry_type($feature)',
  ];

  it.each(GEOM_CASES)('geometry: %s', async (src) => {
    if (!hasPostgis) return;
    for (const g of GEOMS) {
      const js = viaJs(src, {}, g);
      const sql = await viaSql(src, {}, g);
      if (typeof js === 'number') {
        expect(Math.abs((sql as number) - js)).toBeLessThanOrEqual(Math.abs(js) * 1e-6 + 1e-9);
      } else {
        expect(sql).toEqual(js);
      }
    }
  });
});
