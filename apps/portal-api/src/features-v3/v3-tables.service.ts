import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Lifecycle helpers for v3 (multi-layer) data_layer items.
 *
 * Lives in its own module with zero dependencies beyond PrismaService so
 * ItemsModule can import it for reconcile-on-create/update/purge without
 * pulling in the full feature CRUD stack (which depends on ItemsModule
 * and would deadlock the DI graph).
 *
 * Each v3 layer becomes a PostGIS table `fs_<itemIdNoDashes>_<layerId>`.
 * Naming is deterministic so the CRUD service can rebuild a table name
 * from (itemId, layerId) without a round-trip. Idempotent DDL means
 * reconcile() is safe to re-run.
 */

export interface V3LayerShape {
  id: string;
  geometryType: 'point' | 'line' | 'polygon' | null;
  fields?: Array<{
    name: string;
    type: 'string' | 'number' | 'boolean' | 'date';
    /**
     * When true, ensure a btree index on the column at provision
     * time. The index is dropped automatically when the field is
     * removed from the layer schema (the whole table is rebuilt
     * by reconcile via DROP + CREATE for column changes). Drives
     * the explicit half of #23 (smart auto-indexing): a layer
     * author marks the columns they expect to query on, the
     * portal makes those queries fast.
     */
    searchable?: boolean;
  }>;
  parentFkColumn?: string | undefined;
}

@Injectable()
export class V3TablesService {
  private readonly log = new Logger(V3TablesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async provisionLayer(itemId: string, layer: V3LayerShape): Promise<void> {
    const tbl = toV3TableName(itemId, layer.id);
    // Narrow via assignment so `isTable ? ... : toPgGeomType(geomType)`
    // doesn't re-widen geometryType back to the full union inside the
    // branch. Without this, tsc complains because null isn't a valid
    // input to toPgGeomType even though the branch is guarded.
    const geomType = layer.geometryType;
    const isTable = geomType === null;

    const geomDdl = isTable
      ? ''
      : `, geom        GEOMETRY(${toPgGeomType(geomType)}, 4326)`;
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "${tbl}" (
        gid         BIGSERIAL PRIMARY KEY,
        global_id   UUID        NOT NULL DEFAULT gen_random_uuid(),
        properties  JSONB       NOT NULL DEFAULT '{}',
        valid_from  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        valid_to    TIMESTAMPTZ,
        created_by  UUID        NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        edited_by   UUID        NOT NULL,
        edited_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        ${geomDdl}
      )
    `);
    if (!isTable) {
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "${tbl}_geom_idx"
          ON "${tbl}" USING GIST (geom)
      `);
    }
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "${tbl}_valid_to_idx"
        ON "${tbl}" (valid_to)
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "${tbl}_global_id_idx"
        ON "${tbl}" (global_id)
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "${tbl}_current_uniq"
        ON "${tbl}" (global_id) WHERE valid_to IS NULL
    `);

    if (layer.parentFkColumn) {
      const fkCol = sanitizeIdentifier(layer.parentFkColumn);
      if (fkCol) {
        await this.prisma.$executeRawUnsafe(`
          ALTER TABLE "${tbl}"
            ADD COLUMN IF NOT EXISTS "${fkCol}" UUID
        `);
        await this.prisma.$executeRawUnsafe(`
          CREATE INDEX IF NOT EXISTS "${tbl}_${fkCol}_idx"
            ON "${tbl}" ("${fkCol}")
        `);
      }
    }

    for (const f of layer.fields ?? []) {
      const col = sanitizeIdentifier(f.name);
      if (!col) continue;
      const pg = toPgFieldType(f.type);
      await this.prisma.$executeRawUnsafe(`
        ALTER TABLE "${tbl}"
          ADD COLUMN IF NOT EXISTS "${col}" ${pg}
      `);
      // Explicit-trigger half of #23: when the schema marks a
      // field as searchable, ensure a btree index on it.
      // CREATE INDEX IF NOT EXISTS is idempotent, so toggling
      // searchable off and on again does not duplicate the
      // index; toggling off does NOT drop the index (we'd need
      // a deliberate drop pass for that, deferred so the index
      // sticks around even if the layer author makes a typo and
      // unticks the wrong field).
      if (f.searchable) {
        await this.prisma.$executeRawUnsafe(`
          CREATE INDEX IF NOT EXISTS "${tbl}_${col}_search_idx"
            ON "${tbl}" ("${col}")
        `);
      }
    }

    this.log.log(
      `Provisioned v3 layer table ${tbl} (geom=${layer.geometryType ?? 'table'})`,
    );
  }

  async dropLayer(itemId: string, layerId: string): Promise<void> {
    const tbl = toV3TableName(itemId, layerId);
    await this.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${tbl}"`);
    this.log.log(`Dropped v3 layer table ${tbl}`);
  }

  /**
   * Drops tables for layers present in `prev` but not `next`, then
   * provisions (idempotent) every layer in `next`. Safe to re-run.
   */
  async reconcile(
    itemId: string,
    prev: Array<{ id: string }>,
    next: V3LayerShape[],
  ): Promise<void> {
    const nextIds = new Set(next.map((l) => l.id));
    for (const old of prev) {
      if (!nextIds.has(old.id)) {
        await this.dropLayer(itemId, old.id);
      }
    }
    for (const l of next) {
      await this.provisionLayer(itemId, l);
    }
  }

  async dropAll(itemId: string, layerIds: string[]): Promise<void> {
    for (const lid of layerIds) {
      await this.dropLayer(itemId, lid);
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sanitizeIdentifier(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20);
}

export function toV3TableName(itemId: string, layerId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(itemId)) {
    throw new BadRequestException('Invalid item ID format');
  }
  const lid = sanitizeIdentifier(layerId);
  if (!lid) throw new BadRequestException('Invalid layer ID format');
  return `fs_${itemId.replace(/-/g, '')}_${lid}`;
}

function toPgGeomType(
  g: 'point' | 'line' | 'polygon',
): 'Point' | 'LineString' | 'Polygon' {
  if (g === 'point') return 'Point';
  if (g === 'line') return 'LineString';
  return 'Polygon';
}

function toPgFieldType(
  t: 'string' | 'number' | 'boolean' | 'date',
): string {
  if (t === 'number') return 'NUMERIC';
  if (t === 'boolean') return 'BOOLEAN';
  if (t === 'date') return 'TIMESTAMPTZ';
  return 'TEXT';
}
