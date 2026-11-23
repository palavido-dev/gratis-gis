// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Data access in expressions: related records, other layers, lookups
// and spatial queries, run through the SQL compiler against the real
// observation log and through the JavaScript evaluator against the
// same rows, which must agree. It also pins the observation-log rules
// that matter here: only the latest version of a row counts, and a
// deleted row is gone.
//
// Runs in its own schema so it cannot collide with the engine suites
// sharing the database. Skipped unless TEST_DATABASE_URL is set; needs
// PostGIS.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import {
  analyzeExpression,
  compileChecked,
  evaluateChecked,
  type DataResolver,
  type DataSource,
  type ExpressionFeature,
  type FieldRef,
} from '@gratis-gis/shared-types';

import { observationAdapter, type SourceAccess } from './expression-data.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;
if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error('REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset');
}

const NEST_FIELDS: FieldRef[] = [
  { name: 'code', type: 'string' },
  { name: 'zone', type: 'string' },
];
const INSPECTION_FIELDS: FieldRef[] = [
  { name: 'nest_id', type: 'string' },
  { name: 'inspected_on', type: 'date' },
  { name: 'result', type: 'string' },
  { name: 'eggs', type: 'number' },
];
const HYDRANT_FIELDS: FieldRef[] = [
  { name: 'hid', type: 'string' },
  { name: 'zone', type: 'string' },
];
const DISTRICT_FIELDS: FieldRef[] = [{ name: 'name', type: 'string' }];
const OWNER_FIELDS: FieldRef[] = [
  { name: 'nest_code', type: 'string' },
  { name: 'owner', type: 'string' },
];

const src = (key: string, fields: FieldRef[], hasGeometry: boolean, parentFk?: string): DataSource => ({
  key,
  label: key,
  fields,
  hasGeometry,
  itemId: key,
  layerId: key,
  ...(parentFk ? { parentFk } : {}),
});

const SOURCES = {
  nests: src('nests', NEST_FIELDS, true),
  inspections: src('inspections', INSPECTION_FIELDS, false, 'nest_id'),
  hydrants: src('hydrants', HYDRANT_FIELDS, true),
  districts: src('districts', DISTRICT_FIELDS, true),
  owners: src('owners', OWNER_FIELDS, false),
};

const resolver: DataResolver = {
  related: (name) => (name === 'inspections' ? SOURCES.inspections : { error: `no ${name}` }),
  layer: (name) => {
    const s = (SOURCES as Record<string, DataSource>)[name.toLowerCase()];
    return s ?? { error: `no ${name}` };
  },
};

const ACCESS = new Map<string, SourceAccess>(
  Object.keys(SOURCES).map((k) => [k, { scope: `test:${k}`, geoLimit: null, ownRowsUserId: null }]),
);

const CASES = [
  "count(related('inspections'))",
  "exists(related('inspections'))",
  "max(related('inspections'), {{inspected_on}})",
  "min(related('inspections'), {{result}})",
  "first(order_by(related('inspections'), {{inspected_on}}, 'desc')).result",
  "last(order_by(related('inspections'), {{inspected_on}})).result",
  "count(filter(related('inspections'), {{result}} == 'fail'))",
  "sum(related('inspections'), {{eggs}})",
  "avg(related('inspections'), {{eggs}})",
  "count_distinct(related('inspections'), {{result}})",
  "list(order_by(related('inspections'), {{inspected_on}}), {{result}}, '/')",
  "count(top(order_by(related('inspections'), {{inspected_on}}, 'desc'), 2))",
  "date_diff(today(), max(related('inspections'), {{inspected_on}}), 'days') > 0",
  "lookup(layer('Owners'), 'nest_code', {{code}}, 'owner')",
  "nearest(layer('Hydrants')).hid",
  "nearest(layer('Hydrants'), 500, 'meters').hid",
  "round(distance_to(layer('Hydrants'), 'feet'), 2)",
  "count(within_distance(layer('Hydrants'), 2, 'kilometers'))",
  "list(within_distance(layer('Hydrants'), 5, 'km'), {{hid}})",
  "first(containing(layer('Districts'))).name",
  "count(intersecting(layer('Districts')))",
  "count(filter(layer('Hydrants'), {{zone}} == $feature.zone))",
  "round(x(nearest(layer('Hydrants'))), 6)",
  "count(filter(related('inspections'), {{eggs}} > count(filter(layer('Hydrants'), {{zone}} == $feature.zone))))",
];

d('expression data access: SQL and JavaScript agree', () => {
  let db: Client;
  const nests: Array<{ id: string; code: string; zone: string; lon: number; lat: number }> = [];

  async function put(scope: string, entity: string, kind: string, attrs: object | null, geom: string | null, validFrom: string) {
    await db.query(
      `INSERT INTO observation (id, valid_from, scope, entity, kind, attrs, geom, author_sub, source)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::text IS NULL THEN NULL ELSE ST_SetSRID(ST_GeomFromText($7::text), 4326) END, 'u1', '{}')`,
      [randomUUID(), validFrom, scope, entity, kind, attrs ? JSON.stringify(attrs) : null, geom],
    );
  }

  beforeAll(async () => {
    db = new Client({ connectionString: TEST_URL });
    await db.connect();
    await db.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await db.query('DROP SCHEMA IF EXISTS expr_data_spec CASCADE');
    await db.query('CREATE SCHEMA expr_data_spec');
    await db.query('SET search_path TO expr_data_spec, public');
    await db.query(
      readFileSync(join(__dirname, '../../prisma/migrations/20261124090000_expression_functions/migration.sql'), 'utf8'),
    );
    await db.query(`
      CREATE TABLE observation (
        id uuid NOT NULL, tx_time timestamptz NOT NULL DEFAULT now(),
        valid_from timestamptz NOT NULL, valid_to timestamptz,
        scope text NOT NULL, entity uuid NOT NULL, kind text NOT NULL,
        attrs jsonb, geom geometry(Geometry, 4326), author_sub text NOT NULL,
        source jsonb NOT NULL, PRIMARY KEY (id, tx_time))`);
    await db.query('CREATE INDEX ON observation USING GIST (geom)');
    await db.query('CREATE INDEX ON observation USING GIN (attrs jsonb_path_ops)');

    const t0 = '2026-01-01T00:00:00Z';
    for (const [k, [lon, lat, zone]] of ([
      [0, [-117.0, 34.0, 'north']],
      [1, [-117.01, 34.005, 'south']],
      [2, [-117.5, 34.5, 'north']],
    ] as Array<[number, [number, number, string]]>)) {
      const id = randomUUID();
      nests.push({ id, code: `N${k}`, zone, lon, lat });
      await put('test:nests', id, 'create', { code: `N${k}`, zone }, `POINT(${lon} ${lat})`, t0);
    }
    const insp = async (nest: string, day: string, result: string, eggs: number | string) => {
      const id = randomUUID();
      await put('test:inspections', id, 'create', { nest_id: nest, inspected_on: day, result, eggs }, null, t0);
      return id;
    };
    await insp(nests[0]!.id, '2026-03-01', 'pass', 2);
    const changed = await insp(nests[0]!.id, '2026-04-15', 'pass', 3);
    // A later version changes the result: only it may count.
    await put('test:inspections', changed, 'update', { nest_id: nests[0]!.id, inspected_on: '2026-04-15', result: 'fail', eggs: 3 }, null, '2026-04-16T00:00:00Z');
    await insp(nests[0]!.id, '2026-05-20T09:30:00Z', 'fail', 'n/a');
    const gone = await insp(nests[0]!.id, '2026-06-01', 'pass', 9);
    await put('test:inspections', gone, 'delete', null, null, '2026-06-02T00:00:00Z');
    // An inspection moved to another nest no longer belongs to the first.
    const moved = await insp(nests[0]!.id, '2026-02-01', 'pass', 1);
    await put('test:inspections', moved, 'update', { nest_id: nests[1]!.id, inspected_on: '2026-02-01', result: 'pass', eggs: 1 }, null, '2026-02-02T00:00:00Z');
    await insp(nests[1]!.id, '2026-01-10', 'pass', 0);

    for (const [hid, lon, lat, zone] of [
      ['H1', -117.001, 34.001, 'north'],
      ['H2', -117.012, 34.006, 'south'],
      ['H3', -117.03, 34.02, 'north'],
      ['H4', -117.6, 34.6, 'north'],
    ] as Array<[string, number, number, string]>) {
      await put('test:hydrants', randomUUID(), 'create', { hid, zone }, `POINT(${lon} ${lat})`, t0);
    }
    await put('test:districts', randomUUID(), 'create', { name: 'East' }, 'POLYGON((-117.05 33.95, -116.95 33.95, -116.95 34.05, -117.05 34.05, -117.05 33.95))', t0);
    await put('test:districts', randomUUID(), 'create', { name: 'Far' }, 'POLYGON((-118 35, -117.9 35, -117.9 35.1, -118 35.1, -118 35))', t0);
    await put('test:owners', randomUUID(), 'create', { nest_code: 'N0', owner: 'Baker' }, null, t0);
    await put('test:owners', randomUUID(), 'create', { nest_code: 'N2', owner: 'Ruiz' }, null, t0);
  });

  afterAll(async () => {
    await db?.query('DROP SCHEMA IF EXISTS expr_data_spec CASCADE');
    await db?.end();
  });

  /** Current rows of a source, as the JavaScript provider sees them. */
  async function currentRows(source: DataSource): Promise<ExpressionFeature[]> {
    const params: unknown[] = [];
    const bind = (v: unknown, cast: string) => {
      params.push(v);
      return `$${params.length}::${cast}`;
    };
    const sql = observationAdapter(ACCESS).rowsSql(source, { conditions: [] }, bind);
    const r = await db.query(`SELECT global_id::text AS id, ST_AsGeoJSON(geom)::jsonb AS g, properties FROM (${sql}) x`, params);
    return r.rows.map((row) => ({
      kind: 'feature' as const,
      id: row.id,
      properties: row.properties ?? {},
      geometry: row.g,
      fields: source.fields,
    }));
  }

  it.each(CASES)('%s', async (expr) => {
    const cache = new Map<string, ExpressionFeature[]>();
    for (const s of Object.values(SOURCES)) cache.set(s.key, await currentRows(s));
    const a = analyzeExpression(expr, { fields: NEST_FIELDS, data: resolver });
    expect(a.issues).toEqual([]);
    for (const nest of nests) {
      const outer = (await currentRows(SOURCES.nests)).find((f) => f.id === nest.id)!;
      const js = evaluateChecked(a.ast!, a.checked!, {
        feature: outer,
        data: { rows: (s) => cache.get(s.key) ?? [] },
        timeZone: 'UTC',
      });
      const params: unknown[] = [];
      const bind = (v: unknown, cast: string) => {
        params.push(v);
        return `$${params.length}::${cast}`;
      };
      const outerSql = observationAdapter(ACCESS).rowsSql(
        SOURCES.nests,
        { conditions: [`entity = ${bind(nest.id, 'uuid')}`] },
        bind,
      );
      const c = compileChecked(a.ast!, a.checked!, {
        row: { propertiesSql: 'o.properties', geomSql: 'o.geom', idSql: 'o.global_id' },
        paramOffset: params.length,
        dataAdapter: observationAdapter(ACCESS),
      });
      params.push(...c.params);
      const out = c.type === 'date' ? `gg_expr_ts_text(${c.sql})` : c.sql;
      const r = await db.query(`SELECT ${out} AS v FROM (${outerSql}) o`, params);
      const sql = r.rows[0]?.v ?? null;
      const jsv = js instanceof Object && 'ms' in (js as object)
        ? (await db.query('SELECT gg_expr_ts_text(to_timestamp($1::double precision / 1000)) AS t', [(js as { ms: number }).ms])).rows[0].t
        : js;
      if (typeof jsv === 'number' && typeof sql === 'number') {
        expect({ expr, nest: nest.code, v: sql }).toEqual({ expr, nest: nest.code, v: expect.closeTo(jsv, 6) });
      } else {
        expect({ expr, nest: nest.code, v: sql }).toEqual({ expr, nest: nest.code, v: jsv });
      }
    }
  });

  it('reads only the latest version and drops deleted rows', async () => {
    const a = analyzeExpression("list(order_by(related('inspections'), {{inspected_on}}), {{result}}, ',')", {
      fields: NEST_FIELDS,
      data: resolver,
    });
    const params: unknown[] = [];
    const bind = (v: unknown, cast: string) => {
      params.push(v);
      return `$${params.length}::${cast}`;
    };
    const outerSql = observationAdapter(ACCESS).rowsSql(
      SOURCES.nests,
      { conditions: [`entity = ${bind(nests[0]!.id, 'uuid')}`] },
      bind,
    );
    const c = compileChecked(a.ast!, a.checked!, {
      row: { propertiesSql: 'o.properties', geomSql: 'o.geom', idSql: 'o.global_id' },
      paramOffset: params.length,
      dataAdapter: observationAdapter(ACCESS),
    });
    const r = await db.query(`SELECT ${c.sql} AS v FROM (${outerSql}) o`, [...params, ...c.params]);
    // March pass, April (now fail), May fail. The deleted June row and
    // the February row moved to another nest are gone.
    expect(r.rows[0].v).toBe('pass,fail,fail');
  });
});
