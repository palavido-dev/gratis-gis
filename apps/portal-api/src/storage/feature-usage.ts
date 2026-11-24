// SPDX-License-Identifier: AGPL-3.0-or-later
import { Prisma } from '@prisma/client';

/**
 * Estimated storage of feature data, per layer and per organization.
 *
 * What is counted: the live features of each layer (the latest version
 * of each feature that is not deleted), times the average stored size
 * of one feature row in that layer plus the fixed per-row cost of a
 * table row (24-byte tuple header and 4-byte line pointer). Earlier
 * versions kept as edit history, indexes and table bloat are not
 * counted.
 *
 * What it costs: one count over the layer's rows through the
 * (scope, entity, valid_from) index, and, only when the count has moved
 * more than 10% since the last sample or the sample is a week old, an
 * average of pg_column_size over at most SAMPLE_ROWS rows of the
 * layer. Nothing scans the whole observation table.
 *
 * Trashed layers still count (their rows are still stored); purge
 * removes them. Two orgs' numbers never mix: every row carries the
 * item's org, and totals are summed per org.
 */

type Db = {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
  $executeRaw(query: Prisma.Sql): Promise<number>;
};

export const SAMPLE_ROWS = 2000;
/** Tuple header plus line pointer: what a heap row costs beyond its data. */
export const ROW_OVERHEAD_BYTES = 28;
const RESAMPLE_CHANGE = 0.1;
const RESAMPLE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function layerScope(itemId: string, layerKey: string): string {
  return `data_layer:${itemId}:${layerKey}`;
}

export interface LayerMeasure {
  featureCount: number;
  avgRowBytes: number;
  estBytes: number;
  sampled: boolean;
}

/**
 * Measure one layer now and store the result, then refresh its org's
 * feature totals. `force` takes a new size sample regardless.
 */
export async function measureLayer(
  db: Db,
  layer: { itemId: string; layerKey: string; orgId: string },
  opts: { force?: boolean } = {},
): Promise<LayerMeasure> {
  const scope = layerScope(layer.itemId, layer.layerKey);
  const counted = await db.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
    SELECT COUNT(*)::bigint AS n FROM (
      SELECT DISTINCT ON (entity) kind
        FROM observation
       WHERE scope = ${scope}
       ORDER BY entity, valid_from DESC, tx_time DESC, id DESC
    ) latest
    WHERE kind <> 'delete'`);
  const featureCount = Number(counted[0]?.n ?? 0n);
  const prev = await db.$queryRaw<
    Array<{ avg_row_bytes: number; sampled_count: bigint; sampled_at: Date | null }>
  >(Prisma.sql`
    SELECT avg_row_bytes, sampled_count, sampled_at FROM layer_storage_usage
     WHERE item_id = ${layer.itemId}::uuid AND layer_key = ${layer.layerKey}`);
  const p = prev[0];
  const sampledCount = Number(p?.sampled_count ?? 0n);
  const stale =
    opts.force === true ||
    !p?.sampled_at ||
    Date.now() - p.sampled_at.getTime() > RESAMPLE_AGE_MS ||
    Math.abs(featureCount - sampledCount) > RESAMPLE_CHANGE * Math.max(sampledCount, 1);
  let avgRowBytes = p?.avg_row_bytes ?? 0;
  if (stale && featureCount > 0) {
    const avg = await db.$queryRaw<Array<{ b: number | null }>>(Prisma.sql`
      SELECT AVG(pg_column_size(s.*))::float8 AS b FROM (
        SELECT o.* FROM observation o WHERE o.scope = ${scope} LIMIT ${SAMPLE_ROWS}
      ) s`);
    avgRowBytes = Math.round(avg[0]?.b ?? 0);
  }
  const estBytes = featureCount === 0 ? 0 : featureCount * (avgRowBytes + ROW_OVERHEAD_BYTES);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO layer_storage_usage
      (item_id, layer_key, org_id, feature_count, avg_row_bytes, sampled_count, est_bytes, sampled_at, measured_at)
    VALUES (
      ${layer.itemId}::uuid, ${layer.layerKey}, ${layer.orgId}::uuid, ${featureCount}, ${avgRowBytes},
      ${stale ? featureCount : sampledCount}, ${estBytes},
      ${stale ? new Date() : (p?.sampled_at ?? null)}, now()
    )
    ON CONFLICT (item_id, layer_key) DO UPDATE SET
      org_id = EXCLUDED.org_id,
      feature_count = EXCLUDED.feature_count,
      avg_row_bytes = EXCLUDED.avg_row_bytes,
      sampled_count = EXCLUDED.sampled_count,
      est_bytes = EXCLUDED.est_bytes,
      sampled_at = EXCLUDED.sampled_at,
      measured_at = EXCLUDED.measured_at`);
  await refreshOrgFeatureTotals(db, layer.orgId);
  return { featureCount, avgRowBytes, estBytes, sampled: stale };
}

/** Set one org's feature totals to the sum of its layer rows. */
export async function refreshOrgFeatureTotals(db: Db, orgId: string): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    INSERT INTO org_storage_usage (org_id, feature_bytes, feature_count, updated_at)
    SELECT ${orgId}::uuid, COALESCE(SUM(est_bytes), 0), COALESCE(SUM(feature_count), 0), now()
      FROM layer_storage_usage WHERE org_id = ${orgId}::uuid
    ON CONFLICT (org_id) DO UPDATE SET
      feature_bytes = EXCLUDED.feature_bytes,
      feature_count = EXCLUDED.feature_count,
      updated_at = now()`);
}

/** Drop a purged item's layers from its org's feature totals. */
export async function forgetItemFeatureUsage(db: Db, itemId: string, orgId: string): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    DELETE FROM layer_storage_usage WHERE item_id = ${itemId}::uuid AND org_id = ${orgId}::uuid`);
  await refreshOrgFeatureTotals(db, orgId);
}

/**
 * Bring layer_storage_usage in line with the layers that exist: add a
 * row (never measured, so first in line) for each layer of a data
 * layer item, trashed ones included, and drop rows whose item is gone.
 * Reads the item table, not observation.
 */
export async function queueLayers(db: Db): Promise<{ added: number; dropped: number }> {
  const added = await db.$executeRaw(Prisma.sql`
    INSERT INTO layer_storage_usage (item_id, layer_key, org_id)
    SELECT i.id, l.layer->>'id', i.org_id
      FROM item i
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(i.data_json->'layers') = 'array' THEN i.data_json->'layers' ELSE '[]'::jsonb END
      ) AS l(layer)
     WHERE i.type = 'data-layer' AND jsonb_typeof(l.layer->'id') = 'string'
    ON CONFLICT (item_id, layer_key) DO NOTHING`);
  const gone = await db.$queryRaw<Array<{ org_id: string }>>(Prisma.sql`
    DELETE FROM layer_storage_usage u
     WHERE NOT EXISTS (SELECT 1 FROM item i WHERE i.id = u.item_id)
    RETURNING u.org_id::text AS org_id`);
  for (const orgId of new Set(gone.map((r) => r.org_id))) await refreshOrgFeatureTotals(db, orgId);
  return { added, dropped: gone.length };
}

/**
 * The nightly pass: queue new layers, then measure layers oldest
 * first until `budgetMs` runs out. Layers it does not reach keep their
 * last numbers and are first in line next time.
 */
export async function runFeatureUsagePass(
  db: Db,
  opts: { budgetMs: number; now?: () => number },
): Promise<{ measured: number; remaining: number }> {
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.budgetMs;
  await queueLayers(db);
  let measured = 0;
  for (;;) {
    if (now() >= deadline) break;
    const next = await db.$queryRaw<Array<{ item_id: string; layer_key: string; org_id: string }>>(
      Prisma.sql`
        SELECT item_id::text AS item_id, layer_key, org_id::text AS org_id
          FROM layer_storage_usage
         WHERE measured_at IS NULL OR measured_at < ${new Date(deadline - opts.budgetMs)}
         ORDER BY measured_at NULLS FIRST
         LIMIT 20`,
    );
    if (next.length === 0) break;
    for (const l of next) {
      if (now() >= deadline) break;
      await measureLayer(db, { itemId: l.item_id, layerKey: l.layer_key, orgId: l.org_id });
      measured += 1;
    }
  }
  const left = await db.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
    SELECT COUNT(*)::bigint AS n FROM layer_storage_usage
     WHERE measured_at IS NULL OR measured_at < ${new Date(deadline - opts.budgetMs)}`);
  return { measured, remaining: Number(left[0]?.n ?? 0n) };
}
