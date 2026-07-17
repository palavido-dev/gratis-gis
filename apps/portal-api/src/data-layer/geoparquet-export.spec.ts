// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FeatureField } from '@gratis-gis/shared-types';

import {
  writeGeoParquetExport,
  type GeoParquetFeature,
} from './geoparquet-export.js';
import {
  collectParquetFromPath,
  escapeSqlLiteral,
  probeParquetFromPath,
  withSpatialConnection,
} from '../ingest/parquet-reader.js';

/**
 * Round-trip coverage against the REAL @duckdb/node-api binding,
 * for the same reason parquet-reader.spec.ts uses it: the writer's
 * whole job is producing bytes DuckDB's parquet + spatial machinery
 * actually emits, and a mock would prove nothing. The decisive
 * assertion is the GeoParquet `geo` file metadata: the probe alone
 * could pass via the reader's conventional-WKB-blob fallback, so we
 * read the metadata key directly and assert the primary geometry
 * column is declared.
 */
jest.setTimeout(120_000);

function field(
  name: string,
  type: FeatureField['type'],
): FeatureField {
  return { name, type, label: name, nullable: true };
}

async function* pagesOf(
  pages: GeoParquetFeature[][],
): AsyncGenerator<GeoParquetFeature[], void, undefined> {
  for (const page of pages) {
    yield page;
  }
}

/** Parsed GeoParquet `geo` metadata, or null when the file has none
 *  (which for the export spec means "this is NOT GeoParquet"). */
interface GeoMeta {
  primary_column?: string;
  columns?: Record<string, { encoding?: string; geometry_types?: string[] }>;
}
async function readGeoMetadata(path: string): Promise<GeoMeta | null> {
  return withSpatialConnection(async (connection) => {
    const reader = await connection.runAndReadAll(
      `SELECT decode(value) AS geo FROM parquet_kv_metadata('${escapeSqlLiteral(path)}') WHERE key = encode('geo')`,
    );
    const value = reader.getRows()[0]?.[0];
    return typeof value === 'string' ? (JSON.parse(value) as GeoMeta) : null;
  });
}

describe('writeGeoParquetExport', () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'gg-export-spec-'));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('writes real GeoParquet that round-trips through the import reader', async () => {
    const fields: FeatureField[] = [
      field('name', 'string'),
      field('value', 'number'),
      field('active', 'boolean'),
      field('seen_at', 'date'),
      field('tags', 'multi_select'),
    ];
    // Two batches so the append loop crosses a batch boundary; the
    // last row has null geometry AND junk typed values to prove the
    // writer's type coercion + NULL handling.
    const batches: GeoParquetFeature[][] = [
      [
        {
          geometry: { type: 'Point', coordinates: [-79.8534, 38.9256] },
          properties: {
            name: 'Elkins Depot',
            value: 1,
            active: true,
            seen_at: '2026-01-02T03:04:05.000Z',
            tags: ['a', 'b'],
          },
        },
        {
          geometry: { type: 'Point', coordinates: [-79.8501, 38.9207] },
          properties: {
            name: 'Bell Tower',
            value: '2', // numeric string still lands in the DOUBLE column
            active: false,
            seen_at: null,
            tags: [],
          },
        },
      ],
      [
        {
          geometry: null,
          properties: {
            name: 'No Geometry Row',
            value: 'n/a', // out-of-contract: becomes NULL, not a crash
            active: null,
            seen_at: 'not-a-date', // out-of-contract: NULL
            tags: ['c'],
          },
        },
      ],
    ];

    const out = await writeGeoParquetExport({
      workDir,
      fields,
      includeGeometry: true,
      batches: pagesOf(batches),
    });
    expect(out.rows).toBe(3);

    // The import side must recognize the file as one point layer
    // with the declared schema. `tags` comes back as string: the
    // export boundary flattens multi_select to the comma-joined
    // text shape (#107), same as CSV.
    const probe = await probeParquetFromPath(out.path);
    expect(probe.driver).toBe('Parquet');
    const layer = probe.layers[0]!;
    expect(layer.featureCount).toBe(3);
    expect(layer.geometryType).toBe('point');
    expect(layer.fields).toEqual([
      { name: 'name', type: 'string' },
      { name: 'value', type: 'number' },
      { name: 'active', type: 'boolean' },
      { name: 'seen_at', type: 'date' },
      { name: 'tags', type: 'string' },
    ]);

    // The load-bearing assertion: DuckDB attached GeoParquet `geo`
    // metadata on COPY, declaring our geometry column. Without this
    // the file would only import through the WKB-blob fallback and
    // would not be GeoParquet at all.
    const geo = await readGeoMetadata(out.path);
    expect(geo).not.toBeNull();
    expect(geo!.primary_column).toBe('geometry');
    expect(geo!.columns?.geometry?.encoding).toBe('WKB');

    // Value-level round trip. collectParquetFromPath skips rows
    // with NULL geometry (mirroring the GDAL branch), so exactly
    // the two spatial rows come back; that also proves the null
    // geometry survived as a real NULL rather than an error.
    const collected = await collectParquetFromPath(out.path, undefined);
    expect(collected.geojson.features).toHaveLength(2);
    const byName = new Map(
      collected.geojson.features.map((f) => {
        const feat = f as {
          geometry: { type: string; coordinates: [number, number] };
          properties: Record<string, unknown>;
        };
        return [feat.properties.name as string, feat] as const;
      }),
    );
    const depot = byName.get('Elkins Depot')!;
    expect(depot.geometry.type).toBe('Point');
    expect(depot.geometry.coordinates[0]).toBeCloseTo(-79.8534, 4);
    expect(depot.geometry.coordinates[1]).toBeCloseTo(38.9256, 4);
    expect(depot.properties.value).toBe(1);
    expect(depot.properties.active).toBe(true);
    // TIMESTAMPTZ comes back through the reader as ISO-8601 UTC
    // regardless of the host time zone (the reader converts from
    // epoch micros itself; the binding's own text rendering is
    // session-zone dependent), so the round trip is exact.
    expect(depot.properties.seen_at).toBe('2026-01-02T03:04:05.000Z');
    expect(depot.properties.tags).toBe('a,b');
    const tower = byName.get('Bell Tower')!;
    expect(tower.properties.value).toBe(2);
    expect(tower.properties.active).toBe(false);
    expect(tower.properties.seen_at).toBeNull();
    expect(tower.properties.tags).toBe('');
  });

  it('shifts the geometry column name when a field claims "geometry"', async () => {
    const out = await writeGeoParquetExport({
      workDir,
      fields: [field('geometry', 'string')],
      includeGeometry: true,
      batches: pagesOf([
        [
          {
            geometry: { type: 'Point', coordinates: [1, 2] },
            properties: { geometry: 'the user field named geometry' },
          },
        ],
      ]),
    });

    const geo = await readGeoMetadata(out.path);
    expect(geo!.primary_column).toBe('_geometry');

    // The user's field survives as an ordinary string property and
    // the real geometry resolves through the shifted column.
    const probe = await probeParquetFromPath(out.path);
    expect(probe.layers[0]!.fields).toEqual([
      { name: 'geometry', type: 'string' },
    ]);
    expect(probe.layers[0]!.geometryType).toBe('point');
  });

  it('writes plain parquet (no geo metadata) for table-mode layers', async () => {
    const out = await writeGeoParquetExport({
      workDir,
      fields: [field('name', 'string'), field('value', 'number')],
      includeGeometry: false,
      batches: pagesOf([
        [
          { geometry: null, properties: { name: 'row-1', value: 10 } },
          { geometry: null, properties: { name: 'row-2', value: 20 } },
        ],
      ]),
    });
    expect(out.rows).toBe(2);

    expect(await readGeoMetadata(out.path)).toBeNull();

    // Still a valid parquet file with the property columns intact.
    const rowCount = await withSpatialConnection(async (connection) => {
      const reader = await connection.runAndReadAll(
        `SELECT count(*) FROM read_parquet('${escapeSqlLiteral(out.path)}')`,
      );
      const v = reader.getRows()[0]?.[0];
      return typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
    });
    expect(rowCount).toBe(2);
  });
});
