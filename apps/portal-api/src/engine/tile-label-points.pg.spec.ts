// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Label points (tile settings `labelPoints`) against a real PostGIS.
//
// The property under test is global, so the suite reads a block of
// neighbouring tiles and counts across all of them: every line and
// polygon must have exactly ONE label point in the whole block, even
// the ones that cross tile edges, including a polygon centred on a
// tile corner, where a closed-interval test would emit the point in
// four tiles. Decoded with the spec MVT reader, so the counts are per
// MVT layer rather than byte matches.
//
// Runs in its OWN schema (search_path on the connection), never the
// shared `observation` table. Skipped unless TEST_DATABASE_URL is set.

import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { uuidv7 } from '@gratis-gis/engine';

import { DataLayerEngine, dataLayerScope } from './data-layer.js';
import { EngineService } from './engine.service.js';
import { TileCacheService } from './tile-cache.service.js';
import { decodeMvt, type DecodedLayer } from '../testing/mvt-decode.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { LensPolicyService } from '../policy/lens-policy.service.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the label points suite would silently skip.',
  );
}

jest.setTimeout(120_000);

const SCHEMA = 'tile_labels_itest';
const Z = 14;

/** Longitude / latitude of a slippy tile's top-left corner. */
function tileCorner(z: number, x: number, y: number): [number, number] {
  const n = 2 ** z;
  const lng = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [lng, lat];
}

d('label points: one per feature across neighbouring tiles', () => {
  let pool: Pool;
  let client: PrismaClient;
  let prisma: PrismaService;
  let engineSvc: EngineService;
  const makeEngine = () =>
    new DataLayerEngine(
      engineSvc,
      prisma,
      { checkFeature: () => true } as unknown as LensPolicyService,
      new TileCacheService(),
    );

  const itemId = uuidv7();
  const layerId = 'mixed';
  const scope = dataLayerScope(itemId, layerId);

  // A 4x4 block of tiles; the features sit around the corner shared by
  // tiles (X0+1, Y0+1) and (X0+2, Y0+2).
  const X0 = 4500;
  const Y0 = 6250;
  const [cx, cy] = tileCorner(Z, X0 + 2, Y0 + 2);
  const [tx1] = tileCorner(Z, X0 + 3, Y0);
  const tileW = tx1 - cx; // one tile width in degrees

  const cornerSquare = uuidv7(); // polygon centred on a tile corner
  const wideParcel = uuidv7(); // polygon across a vertical tile edge
  const road = uuidv7(); // line across three tiles
  const multiRoad = uuidv7(); // two-part line, longest part elsewhere
  const well = uuidv7(); // a point: never a label point
  const othersParcel = uuidv7(); // created by another user

  async function insert(
    entity: string,
    wkt: string,
    attrs: Record<string, unknown>,
    author = 'itest',
  ): Promise<void> {
    await pool.query(
      `INSERT INTO ${SCHEMA}.observation
         (id, valid_from, scope, entity, kind, attrs, geom, author_sub, source)
       VALUES ($1, now(), $2, $3, 'create', $4, ST_GeomFromText($5, 4326), $6, '{}')`,
      [uuidv7(), scope, entity, JSON.stringify(attrs), wkt, author],
    );
  }

  const sq = (x0: number, y0: number, x1: number, y1: number) =>
    `POLYGON((${x0} ${y0}, ${x1} ${y0}, ${x1} ${y1}, ${x0} ${y1}, ${x0} ${y0}))`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 2 });
    await pool.query(`CREATE EXTENSION IF NOT EXISTS postgis`);
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    await pool.query(`
      CREATE TABLE ${SCHEMA}.observation (
        id           UUID        NOT NULL,
        tx_time      TIMESTAMPTZ NOT NULL DEFAULT now(),
        valid_from   TIMESTAMPTZ NOT NULL,
        valid_to     TIMESTAMPTZ,
        scope        TEXT        NOT NULL,
        entity       UUID        NOT NULL,
        kind         TEXT        NOT NULL,
        attrs        JSONB,
        geom         public.GEOMETRY(Geometry, 4326),
        cell         CHAR(15),
        author_sub   TEXT        NOT NULL,
        source       JSONB       NOT NULL,
        parents      UUID[]      NOT NULL DEFAULT '{}',
        PRIMARY KEY (id, tx_time)
      )
    `);
    client = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: TEST_URL!,
        max: 4,
        options: `-c search_path=${SCHEMA},public`,
      }),
    });
    prisma = client as unknown as PrismaService;
    engineSvc = new EngineService(prisma);

    const h = tileW * 0.3;
    await insert(cornerSquare, sq(cx - h, cy - h, cx + h, cy + h), { name: 'corner', zone: 'A' });
    await insert(
      wideParcel,
      sq(cx - tileW * 1.2, cy + tileW * 0.2, cx - tileW * 0.6, cy + tileW * 0.6),
      { name: 'wide', zone: 'B' },
    );
    await insert(
      road,
      `LINESTRING(${cx - tileW * 1.5} ${cy - tileW * 0.5}, ${cx + tileW * 1.5} ${cy - tileW * 0.5})`,
      { name: 'road', zone: 'C' },
    );
    await insert(
      multiRoad,
      `MULTILINESTRING((${cx + tileW * 0.2} ${cy + tileW * 0.8}, ${cx + tileW * 0.3} ${cy + tileW * 0.8}),` +
        `(${cx - tileW * 1.4} ${cy - tileW * 1.2}, ${cx + tileW * 1.4} ${cy - tileW * 1.2}))`,
      { name: 'multi', zone: 'D' },
    );
    await insert(well, `POINT(${cx + tileW * 0.5} ${cy + tileW * 0.5})`, { name: 'well', zone: 'E' });
    await insert(
      othersParcel,
      sq(cx + tileW * 0.4, cy - tileW * 0.9, cx + tileW * 0.9, cy - tileW * 0.6),
      { name: 'theirs', zone: 'F' },
      'someone-else',
    );
  });

  afterAll(async () => {
    await client?.$disconnect();
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool?.end();
  });

  const FIELDS = [
    { name: 'name', type: 'string' },
    { name: 'zone', type: 'string' },
  ];

  async function block(
    opts: Record<string, unknown>,
  ): Promise<Array<{ x: number; y: number; layers: DecodedLayer[] }>> {
    const engine = makeEngine();
    const out: Array<{ x: number; y: number; layers: DecodedLayer[] }> = [];
    for (let x = X0; x < X0 + 4; x++) {
      for (let y = Y0; y < Y0 + 4; y++) {
        const { mvt } = await engine.mvtTile({ itemId, layerId, z: Z, x, y, ...opts });
        out.push({ x, y, layers: decodeMvt(mvt) });
      }
    }
    return out;
  }

  function countBy(tiles: Array<{ layers: DecodedLayer[] }>, layerName: string) {
    const counts = new Map<string, number>();
    for (const t of tiles) {
      for (const l of t.layers) {
        if (l.name !== layerName) continue;
        for (const f of l.features) {
          const id = String(f.properties._global_id);
          counts.set(id, (counts.get(id) ?? 0) + 1);
        }
      }
    }
    return counts;
  }

  it('is off by default: no labels layer and no marker', async () => {
    const tiles = await block({ fields: FIELDS });
    for (const t of tiles) {
      expect(t.layers.map((l) => l.name)).not.toContain('labels');
      for (const l of t.layers) {
        for (const f of l.features) expect('_label_point' in f.properties).toBe(false);
      }
    }
  });

  it('emits exactly one label point per line and polygon, none for points', async () => {
    const tiles = await block({ fields: FIELDS, labelPoints: true });
    const geometryTiles = countBy(tiles, 'features');
    // The setup really crosses tile edges, or the test proves nothing.
    expect(geometryTiles.get(cornerSquare)).toBe(4);
    expect(geometryTiles.get(wideParcel)!).toBeGreaterThanOrEqual(2);
    expect(geometryTiles.get(road)!).toBeGreaterThanOrEqual(3);

    const labels = countBy(tiles, 'labels');
    expect(labels.get(cornerSquare)).toBe(1);
    expect(labels.get(wideParcel)).toBe(1);
    expect(labels.get(road)).toBe(1);
    expect(labels.get(multiRoad)).toBe(1);
    expect(labels.get(othersParcel)).toBe(1);
    expect(labels.has(well)).toBe(false);
  });

  it('places the point on the feature and carries its attributes', async () => {
    const tiles = await block({ fields: [FIELDS[0]!], labelPoints: true });
    for (const t of tiles) {
      const labelLayer = t.layers.find((l) => l.name === 'labels');
      for (const f of labelLayer?.features ?? []) {
        // The tile's field selection applies to labels too.
        expect(Object.keys(f.properties).sort()).toEqual(['_global_id', 'name']);
        expect(f.type).toBe(1);
        const [px, py] = f.geometry[0]![0]!;
        expect(px).toBeGreaterThanOrEqual(0);
        expect(px).toBeLessThanOrEqual(4096);
        expect(py).toBeGreaterThanOrEqual(0);
        expect(py).toBeLessThanOrEqual(4096);
      }
    }
    // The multi-part line is labelled on its long part, which runs
    // through the bottom row of the block, not on the short stub.
    const multiTile = tiles.find((t) =>
      t.layers.some(
        (l) => l.name === 'labels' && l.features.some((f) => f.properties._global_id === multiRoad),
      ),
    )!;
    expect(multiTile.y).toBe(Y0 + 3);
    // Line and polygon features are marked; the point is not.
    const marks = new Map<string, unknown>();
    for (const t of tiles) {
      for (const f of t.layers.find((l) => l.name === 'features')?.features ?? []) {
        marks.set(String(f.properties._global_id), f.properties._label_point);
      }
    }
    expect(marks.get(cornerSquare)).toBe(true);
    expect(marks.get(road)).toBe(true);
    expect(marks.get(well)).toBe(false);
  });

  it('labels only what the viewer may see (row scope)', async () => {
    const tiles = await block({
      fields: FIELDS,
      labelPoints: true,
      ownRowsOnly: { userId: 'itest' },
    });
    const labels = countBy(tiles, 'labels');
    expect(labels.has(othersParcel)).toBe(false);
    expect(labels.get(cornerSquare)).toBe(1);
  });

  it('falls back to geometry labels in a tile that reached the feature cap', async () => {
    // The block's (X0+1, Y0+1) tile holds several features. With a cap
    // below that count the tile is a sample: a feature can be cut from
    // the one tile holding its label point, so the tile must emit no
    // labels and mark nothing, leaving the map to label geometry.
    const engine = makeEngine();
    const at = { itemId, layerId, z: Z, x: X0 + 1, y: Y0 + 1, fields: FIELDS, labelPoints: true };
    const full = decodeMvt((await engine.mvtTile(at)).mvt);
    expect(full.find((l) => l.name === 'features')!.features.length).toBeGreaterThan(1);
    expect(full.map((l) => l.name)).toEqual(['features', 'labels']);
    const capped = decodeMvt((await engine.mvtTile({ ...at, maxFeaturesPerTile: 1 })).mvt);
    // Which single feature the cap keeps is not ordered, and it can be
    // one whose box touches the tile while its geometry clips away, so
    // the features layer may be empty. The rule under test holds either
    // way: no labels layer, and no feature marked for label points.
    expect(capped.map((l) => l.name)).not.toContain('labels');
    for (const layer of capped) {
      for (const f of layer.features) expect(f.properties._label_point).toBe(false);
    }
  });

  it('does not mark a feature whose label point is outside Web Mercator', async () => {
    // A polygon straddling the 85.05 degree edge: its point on surface
    // is above the Mercator world, so no tile can emit it. Marking it
    // would leave it with no label anywhere.
    const polarLayer = 'polar';
    const polarScope = dataLayerScope(itemId, polarLayer);
    const polar = uuidv7();
    await pool.query(
      `INSERT INTO ${SCHEMA}.observation
         (id, valid_from, scope, entity, kind, attrs, geom, author_sub, source)
       VALUES ($1, now(), $2, $3, 'create', '{}', ST_GeomFromText($4, 4326), 'itest', '{}')`,
      [uuidv7(), polarScope, polar, sq(0.1, 85.0, 0.6, 85.9)],
    );
    const { mvt } = await makeEngine().mvtTile({
      itemId,
      layerId: polarLayer,
      z: 4,
      x: 8,
      y: 0,
      labelPoints: true,
    });
    const layers = decodeMvt(mvt);
    const feat = layers.find((l) => l.name === 'features')!.features;
    expect(feat).toHaveLength(1);
    expect(feat[0]!.properties._label_point).toBe(false);
    expect(layers.find((l) => l.name === 'labels')).toBeUndefined();
  });

  it('keeps label tiles and plain tiles in separate cache slots', async () => {
    const engine = makeEngine();
    const at = { itemId, layerId, z: Z, x: X0 + 1, y: Y0 + 1, fields: FIELDS };
    const plain = await engine.mvtTile(at);
    const withLabels = await engine.mvtTile({ ...at, labelPoints: true });
    expect(withLabels.etag).not.toBe(plain.etag);
    expect(decodeMvt(plain.mvt).map((l) => l.name)).toEqual(['features']);
  });
});
