// SPDX-License-Identifier: AGPL-3.0-or-later
//
// EngineService is the portal-api integration layer for the
// observation-log engine. It accepts engine `Observation` values, fills
// in the bookkeeping fields (`id`, `txTime`, `cell`), validates them,
// inserts them as rows in the `observation` table, and reads them back
// as GeoJSON features.
//
// Phase 1: no policy enforcement (everything is permitted), no
// materialized views, no streaming. Reads always hit the live log.
// Policy + lens runtime + MV cache land in Phase 2 and beyond.
//
// SQL is hand-written via Prisma's `$queryRaw` / `$executeRaw` because
// the `observation` table is intentionally not modeled in
// `schema.prisma` (Prisma cannot express PARTITION BY, UUIDv7 ids
// from app code, or the spatial / GIN indexes we rely on).

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  type GeoJsonGeometry,
  type Observation,
  type ObservationKind,
  type ReadFeature,
  type ReadQuery,
  cellForGeometry,
  uuidv7,
  validateObservation,
} from '@gratis-gis/engine';

/** Hard cap on rows per INSERT statement.
 *
 *  PostgreSQL's per-statement parameter cap is around 32,000. Each
 *  observation row binds 13 parameters, so a 500-row batch uses 6,500
 *  parameters per statement, comfortably under the cap. The 500
 *  number matches the v3 service's existing batch size so single-
 *  shapefile ingest runs land in roughly the same wall-clock as
 *  before once the rewire completes.
 */
// Multi-row INSERT chunk size for writeMany. Each observation row
// uses 13 placeholders (id, tx_time, valid_from, valid_to, scope,
// entity, kind, attrs, geom, cell, author_sub, source, parents),
// and PostgreSQL's wire protocol caps a prepared statement at
// 65535 parameters. Hard ceiling: 65535 / 13 = ~5040 rows. 2000
// leaves comfortable headroom and keeps the round-trip count
// manageable on bulk imports (1.4M features = 700 INSERTs at
// 2000/chunk vs 2800 at 500/chunk -- 4x fewer client-server
// round-trips, with no observable per-INSERT slowdown). The
// outer streaming-ingest batch (5000 in IngestService) is
// independent of this and governs JS memory + progress-event
// granularity, not DB load.
const WRITE_BATCH_SIZE = 2000;

import { PrismaService } from '../prisma/prisma.service.js';

interface ObservationRow {
  id: string;
  tx_time: Date;
  valid_from: Date;
  valid_to: Date | null;
  scope: string;
  entity: string;
  kind: ObservationKind;
  attrs: Record<string, unknown> | null;
  geom_geojson: GeoJsonGeometry | null;
  cell: string | null;
  author_sub: string;
  source: { kind: string; details?: Record<string, unknown> };
  parents: string[];
}

@Injectable()
export class EngineService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly writeListeners: Array<(scopes: ReadonlySet<string>) => void> = [];

  /**
   * Be told, in-process and synchronously, which scopes a write just
   * landed in. DataLayerEngine uses this to drop its cached tiles and
   * aggregates before the write returns, so a caller that writes and
   * reads back through the same replica never sees the pre-write
   * answer. The observation trigger's NOTIFY covers the other replica
   * a network hop later. Every write path in this service reports,
   * so a writer that skips DataLayerEngine (the OSM save-as-layer
   * path does) is still covered.
   */
  onWrite(listener: (scopes: ReadonlySet<string>) => void): void {
    this.writeListeners.push(listener);
  }

  private notifyWritten(observations: ReadonlyArray<{ scope: string }>): void {
    if (this.writeListeners.length === 0 || observations.length === 0) return;
    const scopes = new Set(observations.map((o) => o.scope));
    for (const listener of this.writeListeners) listener(scopes);
  }

  /**
   * Write an observation to the log. Fills in `id` (UUIDv7), `txTime`
   * (now), and `cell` (H3 res 7) when omitted. Validates the result
   * and throws on malformed input. Returns the persisted observation
   * with all bookkeeping fields populated.
   */
  async write(input: Observation): Promise<Observation> {
    const obs: Observation = {
      ...input,
      id: input.id ?? uuidv7(),
      txTime: input.txTime ?? new Date(),
      cell: input.cell ?? cellForGeometry(input.geom),
    };
    validateObservation(obs);

    const geomJson = obs.geom !== null ? JSON.stringify(obs.geom) : null;
    const attrsJson = obs.attrs !== null ? JSON.stringify(obs.attrs) : null;
    const sourceJson = JSON.stringify(obs.source);

    await this.prisma.$executeRaw`
      INSERT INTO observation (
        id, tx_time, valid_from, valid_to, scope, entity, kind,
        attrs, geom, cell, author_sub, source, parents
      ) VALUES (
        ${obs.id}::uuid,
        ${obs.txTime}::timestamptz,
        ${obs.validFrom}::timestamptz,
        ${obs.validTo}::timestamptz,
        ${obs.scope},
        ${obs.entity}::uuid,
        ${obs.kind},
        ${attrsJson}::jsonb,
        ${
          geomJson === null
            ? Prisma.sql`NULL`
            : Prisma.sql`ST_GeomFromGeoJSON(${geomJson}::text)`
        },
        ${obs.cell ?? null},
        ${obs.author.sub},
        ${sourceJson}::jsonb,
        ${obs.parents}::uuid[]
      )
    `;

    this.notifyWritten([obs]);
    return obs;
  }

  /**
   * Write many observations in batched INSERTs. Validates and fills
   * `id`, `txTime`, and `cell` for each input the same way `write`
   * does, then runs one multi-row INSERT per WRITE_BATCH_SIZE chunk.
   *
   * Order is preserved: the returned array matches the input order
   * one-for-one, with bookkeeping fields populated.
   *
   * Failure mode: if any chunk fails, prior chunks have already been
   * persisted. Callers that need transactional all-or-nothing
   * semantics across a large batch should wrap the call in their own
   * `prisma.$transaction`. Today's v3 ingest does not need that
   * (partial ingest is recoverable; the caller logs and retries).
   */
  async writeMany(inputs: Observation[]): Promise<Observation[]> {
    if (inputs.length === 0) return [];

    const filled: Observation[] = inputs.map((obs) => ({
      ...obs,
      id: obs.id ?? uuidv7(),
      txTime: obs.txTime ?? new Date(),
      cell: obs.cell ?? cellForGeometry(obs.geom),
    }));
    for (const obs of filled) validateObservation(obs);

    for (let i = 0; i < filled.length; i += WRITE_BATCH_SIZE) {
      const batch = filled.slice(i, i + WRITE_BATCH_SIZE);
      const params: unknown[] = [];
      const valueRows: string[] = [];
      for (const obs of batch) {
        const base = params.length + 1;
        const geomJson = obs.geom !== null ? JSON.stringify(obs.geom) : null;
        params.push(
          obs.id,
          obs.txTime,
          obs.validFrom,
          obs.validTo,
          obs.scope,
          obs.entity,
          obs.kind,
          obs.attrs !== null ? JSON.stringify(obs.attrs) : null,
          geomJson,
          obs.cell ?? null,
          obs.author.sub,
          JSON.stringify(obs.source),
          obs.parents,
        );
        valueRows.push(
          `($${base}::uuid, $${base + 1}::timestamptz, ` +
            `$${base + 2}::timestamptz, $${base + 3}::timestamptz, ` +
            `$${base + 4}, $${base + 5}::uuid, $${base + 6}, ` +
            `$${base + 7}::jsonb, ` +
            `CASE WHEN $${base + 8}::text IS NULL THEN NULL ` +
            `ELSE ST_GeomFromGeoJSON($${base + 8}::text) END, ` +
            `$${base + 9}, $${base + 10}, ` +
            `$${base + 11}::jsonb, $${base + 12}::uuid[])`,
        );
      }
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO observation ` +
          `(id, tx_time, valid_from, valid_to, scope, entity, kind, ` +
          `attrs, geom, cell, author_sub, source, parents) ` +
          `VALUES ${valueRows.join(', ')}`,
        ...params,
      );
    }

    this.notifyWritten(filled);
    return filled;
  }

  /**
   * Bulk write observations via PostgreSQL's COPY FROM STDIN.
   *
   * Where writeMany batches multi-row INSERTs at WRITE_BATCH_SIZE
   * rows per statement (still going through the SQL parser and
   * parameter binder for every batch), copyMany ships rows over
   * the wire as text-format COPY lines that the server applies
   * with no per-row SQL parsing. Geometries are encoded as EWKT
   * (`SRID=4326;POINT (...)`) so PostGIS skips ST_GeomFromGeoJSON
   * entirely. Inside one transaction the COPY also runs with
   * SET LOCAL synchronous_commit=off, trading per-batch fsync
   * for higher throughput on a re-runnable bulk import.
   *
   * Empirically 5-10x faster than writeMany on a county-scale
   * parcel ingest (1.4M polygons, 19 attribute fields). Use for
   * the async-import-job worker; keep writeMany for online
   * single-row writes where the per-row overhead doesn't matter.
   *
   * Rather than open the pg connection here, the caller passes
   * an already-started CopyWriter -- this lets the worker hold
   * one transaction open across many batches (one transaction
   * per import is much cheaper than one per batch) and aborts
   * cleanly on cancellation.
   */
  async copyMany(
    inputs: Observation[],
    writer: import('./copy-writer.js').CopyWriter,
  ): Promise<Observation[]> {
    if (inputs.length === 0) return [];
    // Skip cellForGeometry in the bulk-import path: #115 P4 dropped
    // observation_cell_idx, so the column is unindexed. The COPY
    // writer also passes cell=null when the caller doesn't supply
    // one, which is the same behavior. Saves 1.4M h3-js calls per
    // county-scale import.
    const filled: Observation[] = inputs.map((obs) => ({
      ...obs,
      id: obs.id ?? uuidv7(),
      txTime: obs.txTime ?? new Date(),
      cell: obs.cell ?? null,
    }));
    for (const obs of filled) validateObservation(obs);
    // P9: ship the whole batch in one postMessage to the encoder
    // worker_thread instead of N per-row write() calls. The encoder
    // returns the joined COPY-line string; the writer pushes it to
    // the pg-copy-streams socket in one shot.
    await writer.writeBatch(filled);
    this.notifyWritten(filled);
    return filled;
  }

  /**
   * Read the current truth (or the truth at `asOf`) for entities in
   * a scope. Returns one GeoJSON feature per entity. Tombstones
   * (`kind = 'delete'`) are filtered out so deleted entities do not
   * appear in the result.
   *
   * Phase 1 is intentionally minimal: no attribute filters, no
   * geometry filters. Those land with the lens runtime in Phase 3.
   */
  async read(query: ReadQuery): Promise<ReadFeature[]> {
    const asOf = query.asOf ?? new Date();
    const limit = query.limit ?? 1000;

    const entityFilter =
      query.entity !== undefined
        ? Prisma.sql`AND entity = ${query.entity}::uuid`
        : Prisma.empty;

    const rows = await this.prisma.$queryRaw<ObservationRow[]>`
      WITH currents AS (
        SELECT DISTINCT ON (entity)
          id,
          tx_time,
          valid_from,
          valid_to,
          scope,
          entity,
          kind,
          attrs,
          ST_AsGeoJSON(geom)::jsonb AS geom_geojson,
          cell,
          author_sub,
          source,
          parents
        FROM observation
        WHERE scope = ${query.scope}
          AND valid_from <= ${asOf}::timestamptz
          ${entityFilter}
        ORDER BY entity, valid_from DESC, tx_time DESC
      )
      SELECT *
      FROM currents
      WHERE kind <> 'delete'
      LIMIT ${limit}
    `;

    return rows.map(rowToFeature);
  }
}

function rowToFeature(row: ObservationRow): ReadFeature {
  return {
    type: 'Feature',
    id: row.entity,
    geometry: row.geom_geojson,
    properties: {
      ...(row.attrs ?? {}),
      __engine: {
        observationId: row.id,
        validFrom: row.valid_from.toISOString(),
        validTo: row.valid_to !== null ? row.valid_to.toISOString() : null,
        txTime: row.tx_time.toISOString(),
        kind: row.kind,
        authorSub: row.author_sub,
      },
    },
  };
}
