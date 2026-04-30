import { BadRequestException, Injectable } from '@nestjs/common';
import type { Item } from '@prisma/client';
import {
  DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
  type DerivedLayerData,
  type FeatureField,
  type ToolStep,
} from '@gratis-gis/shared-types';

import { PrismaService } from '../prisma/prisma.service.js';
import { toV3TableName } from '../features-v3/v3-tables.service.js';
import { getGeneratorForStep } from './tools/registry.js';

/**
 * Maximum allowed pipeline length. Each step is a separate CTE in
 * the chained read SQL, so planning cost and peak materialization
 * memory both grow with step count. Ten covers any realistic recipe
 * with headroom (a typical chained workflow is 3-6 steps), trips
 * before a runaway client can post a thousand-step pipeline, and
 * keeps the user-facing complexity bounded. The per-tool runtime
 * caps (MAX_BUFFER_DISTANCE_METERS, MAX_CELLS_PER_RECIPE,
 * featureLimit) are the load-bearing safety nets; this one is the
 * "are you sure?" check.
 */
const MAX_PIPELINE_STEPS = 10;

/**
 * Hard cap on the user-overridable feature limit. The default sits
 * at 1000 (see DEFAULT_DERIVED_LAYER_FEATURE_LIMIT) but power users
 * can raise it; this is the ceiling. Keeps a misconfigured layer
 * from being a denial-of-service path.
 */
const MAX_FEATURE_LIMIT = 50_000;

/**
 * Approximate degrees of latitude per meter at the equator. Used
 * once when expanding a request bbox by the pipeline's outward
 * reach so features near the edge keep their halo. The value is
 * deliberately a constant (1 / 111_320) rather than a per-latitude
 * approximation: at high latitudes the longitudinal expansion would
 * need to be larger, so we use the SAME meters-per-degree on both
 * axes (treating the latitude axis as the worst case). This
 * over-includes longitudinal features near the poles, which is fine
 * for a pre-filter that exists only to limit work.
 */
const DEGREES_PER_METER = 1 / 111_320;

/**
 * Mechanics for derived_layer items: validation + read-path SQL
 * composition. Per-user authorization (can the caller read the
 * source data layer?) lives in items.service so this module
 * doesn't import the items module and we keep the dependency graph
 * one-directional. Callers pass the already-authorized source
 * Item into both methods.
 */
@Injectable()
export class DerivedLayersService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------
  // Validation + enrichment (called by items.service on save)
  // ---------------------------------------------------------------

  /**
   * Validate a derived_layer's `data` payload, run each tool's
   * validator, and compute the cached `outputSchema` and `bbox` from
   * the source. Tools that declare an `enrich` hook (currently
   * `buffer` field-mode for the per-feature distance cap) get a
   * source-aware async pass. Returns the enriched, persistable data.
   * Throws `BadRequestException` for any validation failure.
   *
   * The caller is expected to have already authorized the user
   * against `sourceItem`. This method only verifies the source's
   * type and shape.
   */
  async validateAndEnrich(
    rawData: unknown,
    sourceItem: Pick<Item, 'id' | 'type' | 'data' | 'bbox'>,
  ): Promise<DerivedLayerData> {
    if (!rawData || typeof rawData !== 'object') {
      throw new BadRequestException('derived_layer data must be an object');
    }
    const d = rawData as Record<string, unknown>;
    if (d.version !== 1) {
      throw new BadRequestException(
        'derived_layer.version must be 1 (this is the only supported version)',
      );
    }
    const source = d.source as Record<string, unknown> | undefined;
    if (
      !source ||
      source.kind !== 'data_layer' ||
      typeof source.itemId !== 'string' ||
      source.itemId.length === 0
    ) {
      throw new BadRequestException(
        'derived_layer.source must be { kind: "data_layer", itemId: <uuid> }',
      );
    }
    if (source.itemId !== sourceItem.id) {
      throw new BadRequestException(
        'derived_layer.source.itemId must match the resolved source item',
      );
    }
    if (sourceItem.type !== 'data_layer') {
      throw new BadRequestException(
        'derived_layer.source.itemId must reference a data_layer item',
      );
    }

    // v3 multi-layer items split features across one PostGIS table per
    // sublayer, so the recipe MUST name which sublayer to derive from.
    // v2 single-table items have no sublayer, so layerKey must be
    // absent. Reject both directions explicitly: a missing layerKey
    // on a v3 source would silently query a non-existent table, and
    // a layerKey on a v2 source would imply structure that isn't
    // there. The check runs before tool validation so a mismatched
    // recipe never reaches the generators.
    const sourceVersion = readSourceVersion(sourceItem.data);
    const sublayer = resolveSublayer(
      sourceItem.data,
      sourceVersion,
      typeof source.layerKey === 'string' ? source.layerKey : undefined,
    );

    const pipeline = d.pipeline;
    if (!Array.isArray(pipeline) || pipeline.length === 0) {
      throw new BadRequestException(
        'derived_layer.pipeline must be a non-empty array of tool steps',
      );
    }
    if (pipeline.length > MAX_PIPELINE_STEPS) {
      throw new BadRequestException(
        `derived_layer.pipeline must not exceed ${MAX_PIPELINE_STEPS} steps`,
      );
    }

    const featureLimitRaw = d.featureLimit;
    let featureLimit = DEFAULT_DERIVED_LAYER_FEATURE_LIMIT;
    if (typeof featureLimitRaw === 'number') {
      if (
        !Number.isFinite(featureLimitRaw) ||
        featureLimitRaw <= 0 ||
        !Number.isInteger(featureLimitRaw)
      ) {
        throw new BadRequestException(
          'derived_layer.featureLimit must be a positive integer',
        );
      }
      if (featureLimitRaw > MAX_FEATURE_LIMIT) {
        throw new BadRequestException(
          `derived_layer.featureLimit must not exceed ${MAX_FEATURE_LIMIT}`,
        );
      }
      featureLimit = featureLimitRaw;
    }

    // Validate each step's params, threading the schema forward so a
    // step that changes the column shape (future: dissolve) yields
    // the right input schema for the next step. The schema comes
    // from the resolved sublayer for v3, or top-level fields for v2.
    const sourceSchema = sublayer
      ? sublayer.fields
      : readSourceSchema(sourceItem.data);
    // Source feature table, pre-quoted, for any tool's `enrich` hook
    // that needs to query against it (buffer's field-mode max
    // computation is the only consumer in v1). v3 uses the per-
    // sublayer table; v2 uses the single fs_<itemId> table.
    const sourceTable = sublayer
      ? `"${toV3TableName(sourceItem.id, sublayer.id)}"`
      : `"fs_${sourceItem.id.replace(/-/g, '')}"`;
    let schema: FeatureField[] = sourceSchema;
    let totalReachMeters = 0;
    const validatedPipeline: ToolStep[] = [];
    for (let i = 0; i < pipeline.length; i++) {
      const stepRaw = pipeline[i];
      if (!stepRaw || typeof stepRaw !== 'object') {
        throw new BadRequestException(
          `derived_layer.pipeline[${i}] must be an object`,
        );
      }
      const tool = (stepRaw as { tool?: unknown }).tool;
      if (typeof tool !== 'string') {
        throw new BadRequestException(
          `derived_layer.pipeline[${i}].tool must be a string`,
        );
      }
      const generator = getGeneratorForStep({
        tool,
        params: (stepRaw as { params?: unknown }).params,
      } as ToolStep);
      const validated = generator.validate(
        (stepRaw as { params?: unknown }).params,
        { sourceSchema: schema },
      );
      // Async enrichment hook: tools fill in any caches the recipe
      // needs (buffer's field-mode `cachedMaxMeters`). Only fired at
      // save time; reads trust the persisted shape.
      const enrichedParams = generator.enrich
        ? await generator.enrich(validated, {
            sourceSchema: schema,
            sourceTable,
            queryRaw: <T = unknown>(sql: string, ...p: unknown[]) =>
              this.prisma.$queryRawUnsafe<T[]>(sql, ...p),
          })
        : validated;
      schema = generator.outputSchema(schema, enrichedParams);
      totalReachMeters += generator.outwardReachMeters(enrichedParams);
      validatedPipeline.push({ tool, params: enrichedParams } as ToolStep);
    }

    const bbox = padBboxByMeters(
      Array.isArray(sourceItem.bbox) ? sourceItem.bbox : [],
      totalReachMeters,
    );

    return {
      version: 1,
      source: {
        kind: 'data_layer',
        itemId: source.itemId as string,
        ...(sublayer ? { layerKey: sublayer.id } : {}),
      },
      pipeline: validatedPipeline,
      featureLimit,
      outputSchema: schema,
      bbox,
    };
  }

  // ---------------------------------------------------------------
  // Read path (called by items.service.getGeoJson)
  // ---------------------------------------------------------------

  /**
   * Compose a chained CTE over the source's PostGIS table and stream
   * the result as GeoJSON. The caller has already passed an ACL
   * check on both the derived layer AND the source data layer. A
   * mismatched / wrong-type / missing source returns an empty
   * FeatureCollection so a momentary inconsistency degrades
   * gracefully.
   */
  async getGeoJson(
    item: Item,
    sourceItem: Pick<Item, 'id' | 'type' | 'data'> | null,
    opts: {
      bbox?: [number, number, number, number];
      at?: string;
      boundaryClipId?: string;
    } = {},
  ): Promise<{ type: 'FeatureCollection'; features: unknown[] }> {
    const data = item.data as unknown as DerivedLayerData | null;
    if (!data || data.version !== 1) {
      // Older shape we don't recognize; safest is empty.
      return { type: 'FeatureCollection', features: [] };
    }
    if (
      !sourceItem ||
      sourceItem.type !== 'data_layer' ||
      sourceItem.id !== data.source.itemId
    ) {
      return { type: 'FeatureCollection', features: [] };
    }

    const storageType = (sourceItem.data as { storageType?: string } | null)
      ?.storageType;
    if (storageType !== 'postgis') {
      // v1 inline-GeoJSON data layers don't have a PostGIS table to
      // join against. Future work could lift the GeoJSON into a
      // temp CTE for these; for now, empty.
      return { type: 'FeatureCollection', features: [] };
    }

    // Total outward reach across the pipeline, used to expand the
    // request bbox before querying the source so features near the
    // edge keep their buffer halo.
    let totalReachMeters = 0;
    for (const step of data.pipeline) {
      const generator = getGeneratorForStep(step);
      totalReachMeters += generator.outwardReachMeters(
        generator.validate(step.params),
      );
    }

    const tbl = data.source.layerKey
      ? toV3TableName(data.source.itemId, data.source.layerKey)
      : `fs_${data.source.itemId.replace(/-/g, '')}`;
    const queryParams: unknown[] = [];
    const sourceConditions: string[] = [];

    // Temporal: matches items.service.getGeoJson exactly so a
    // derived layer's "as of" answers are consistent with the
    // source's.
    if (opts.at) {
      const ts = new Date(opts.at);
      if (!isNaN(ts.getTime())) {
        queryParams.push(ts.toISOString());
        const p = queryParams.length;
        sourceConditions.push(
          `valid_from <= $${p}::timestamptz AND (valid_to IS NULL OR valid_to > $${p}::timestamptz)`,
        );
      }
    } else {
      sourceConditions.push('valid_to IS NULL');
    }

    // Bbox prefilter on the source, expanded by the pipeline's
    // outward reach. The expansion uses a single meters-per-degree
    // approximation (see DEGREES_PER_METER comment) so we err
    // wider at high latitudes.
    if (opts.bbox) {
      const padding = totalReachMeters * DEGREES_PER_METER;
      const [minX, minY, maxX, maxY] = opts.bbox;
      queryParams.push(
        minX - padding,
        minY - padding,
        maxX + padding,
        maxY + padding,
      );
      const b = queryParams.length;
      sourceConditions.push(
        `geom IS NOT NULL AND ST_Intersects(geom, ST_MakeEnvelope($${b - 3}, $${b - 2}, $${b - 1}, $${b}, 4326))`,
      );
    }

    if (opts.boundaryClipId) {
      // Boundary clip resolves through a single read of the
      // geo_boundary item. Mirrors items.service.getGeoJson; the
      // boundary geometry is treated as authoritative regardless of
      // the calling user's per-boundary permissions because the
      // map author already chose to clip to it.
      const boundary = await this.prisma.item.findFirst({
        where: {
          id: opts.boundaryClipId,
          type: 'geo_boundary',
          deletedAt: null,
        },
        select: { data: true },
      });
      const g = (boundary?.data as { geometry?: unknown } | null)?.geometry;
      if (g && typeof g === 'object') {
        queryParams.push(JSON.stringify(g));
        const p = queryParams.length;
        sourceConditions.push(
          `geom IS NOT NULL AND ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON($${p}::text), 4326))`,
        );
      }
    }

    // Build the full chained CTE. Step CTE names are 1-indexed so a
    // glance at the SQL maps directly to user-facing step ordering.
    const sourceWhere =
      sourceConditions.length > 0
        ? `WHERE ${sourceConditions.join(' AND ')}`
        : '';
    const ctes: string[] = [
      `source AS (
        SELECT global_id, geom, properties
        FROM "${tbl}"
        ${sourceWhere}
      )`,
    ];
    let inputAlias = 'source';
    for (let i = 0; i < data.pipeline.length; i++) {
      const step = data.pipeline[i]!;
      const generator = getGeneratorForStep(step);
      const params = generator.validate(step.params);
      const fragment = generator.toSql(
        inputAlias,
        params,
        queryParams.length,
      );
      const cteName = `step_${i + 1}`;
      ctes.push(`${cteName} AS (${fragment.sql})`);
      queryParams.push(...fragment.params);
      inputAlias = cteName;
    }

    queryParams.push(data.featureLimit);
    const limitParam = queryParams.length;

    const sql = `
      WITH ${ctes.join(', ')}
      SELECT global_id, ST_AsGeoJSON(geom) AS geom, properties
      FROM ${inputAlias}
      WHERE geom IS NOT NULL
      LIMIT $${limitParam}
    `;

    type RawRow = {
      global_id: string;
      geom: string | null;
      properties: Record<string, unknown> | null;
    };
    const rows = await this.prisma.$queryRawUnsafe<RawRow[]>(
      sql,
      ...queryParams,
    );

    return {
      type: 'FeatureCollection',
      features: rows.map((r) => ({
        type: 'Feature',
        id: r.global_id,
        geometry: r.geom ? JSON.parse(r.geom) : null,
        properties: r.properties ?? {},
      })),
    };
  }

  /**
   * Build the same CTE/SQL the read path uses, but return it as a
   * string with parameters rather than executing. Used by tests so
   * we can assert SQL shape without a live database, and used by
   * the future "explain plan" admin tool. Pure: takes the resolved
   * source instead of looking it up.
   */
  buildReadSql(
    item: Item,
    sourceItem: Pick<Item, 'id' | 'data'>,
    opts: {
      bbox?: [number, number, number, number];
      at?: string;
    } = {},
  ): { sql: string; params: unknown[] } {
    const data = item.data as unknown as DerivedLayerData;
    let totalReachMeters = 0;
    for (const step of data.pipeline) {
      const generator = getGeneratorForStep(step);
      totalReachMeters += generator.outwardReachMeters(
        generator.validate(step.params),
      );
    }
    const tbl = data.source.layerKey
      ? toV3TableName(sourceItem.id, data.source.layerKey)
      : `fs_${sourceItem.id.replace(/-/g, '')}`;
    const queryParams: unknown[] = [];
    const sourceConditions: string[] = [];

    if (opts.at) {
      queryParams.push(opts.at);
      const p = queryParams.length;
      sourceConditions.push(
        `valid_from <= $${p}::timestamptz AND (valid_to IS NULL OR valid_to > $${p}::timestamptz)`,
      );
    } else {
      sourceConditions.push('valid_to IS NULL');
    }

    if (opts.bbox) {
      const padding = totalReachMeters * DEGREES_PER_METER;
      const [minX, minY, maxX, maxY] = opts.bbox;
      queryParams.push(
        minX - padding,
        minY - padding,
        maxX + padding,
        maxY + padding,
      );
      const b = queryParams.length;
      sourceConditions.push(
        `geom IS NOT NULL AND ST_Intersects(geom, ST_MakeEnvelope($${b - 3}, $${b - 2}, $${b - 1}, $${b}, 4326))`,
      );
    }

    const sourceWhere =
      sourceConditions.length > 0
        ? `WHERE ${sourceConditions.join(' AND ')}`
        : '';
    const ctes: string[] = [
      `source AS (
        SELECT global_id, geom, properties
        FROM "${tbl}"
        ${sourceWhere}
      )`,
    ];
    let inputAlias = 'source';
    for (let i = 0; i < data.pipeline.length; i++) {
      const step = data.pipeline[i]!;
      const generator = getGeneratorForStep(step);
      const params = generator.validate(step.params);
      const fragment = generator.toSql(
        inputAlias,
        params,
        queryParams.length,
      );
      const cteName = `step_${i + 1}`;
      ctes.push(`${cteName} AS (${fragment.sql})`);
      queryParams.push(...fragment.params);
      inputAlias = cteName;
    }

    queryParams.push(data.featureLimit);
    const limitParam = queryParams.length;

    const sql = `
      WITH ${ctes.join(', ')}
      SELECT global_id, ST_AsGeoJSON(geom) AS geom, properties
      FROM ${inputAlias}
      WHERE geom IS NOT NULL
      LIMIT $${limitParam}
    `;
    return { sql, params: queryParams };
  }
}

// -----------------------------------------------------------------
// Helpers (pure; lifted out so tests can poke them directly)
// -----------------------------------------------------------------

/**
 * Read the schema version off a data_layer's `data` blob. v1 and v2
 * are flat (fields at the top level), v3 is multi-layer (fields per
 * sublayer). Falls back to 0 for unknown / malformed shapes so the
 * caller can branch defensively. Returns just the version number;
 * callers that need to dispatch on it are expected to compare by
 * value rather than rely on a typed union here (the data blob is
 * Prisma `JsonValue`, narrowing to a discriminated union would
 * require zod / class-validator for no real win).
 */
export function readSourceVersion(data: unknown): number {
  if (!data || typeof data !== 'object') return 0;
  const v = (data as { version?: unknown }).version;
  return typeof v === 'number' ? v : 0;
}

/**
 * Resolve which sublayer the recipe targets, or `null` for a v1 / v2
 * single-table item.
 *
 * Rules:
 *   - v3 source REQUIRES `layerKey`. Missing or unknown key throws.
 *     A v3 item with exactly one spatial sublayer is allowed to
 *     auto-select; we do that here so the wizard doesn't have to.
 *   - v2 source FORBIDS `layerKey`. Passing one means the recipe is
 *     pointed at structure that doesn't exist; throw rather than
 *     silently ignore.
 *   - v1 (inline GeoJSON) returns null and lets the caller's
 *     storageType check reject it later.
 *
 * Returns the sublayer object when one is selected, or `null` when
 * the source is single-table.
 */
export function resolveSublayer(
  data: unknown,
  version: number,
  layerKey: string | undefined,
): { id: string; fields: FeatureField[] } | null {
  if (version !== 3) {
    if (layerKey !== undefined) {
      throw new BadRequestException(
        'derived_layer.source.layerKey is only valid against v3 multi-layer data layers',
      );
    }
    return null;
  }
  // v3 path
  const layers = (data as { layers?: unknown }).layers;
  if (!Array.isArray(layers) || layers.length === 0) {
    throw new BadRequestException(
      'Source data layer has no sublayers; add a layer in the data layer builder first',
    );
  }
  const spatialLayers = layers.filter((l) => {
    if (!l || typeof l !== 'object') return false;
    const id = (l as { id?: unknown }).id;
    const geom = (l as { geometryType?: unknown }).geometryType;
    return typeof id === 'string' && id.length > 0 && typeof geom === 'string';
  }) as Array<{ id: string; geometryType: string; fields?: FeatureField[] }>;
  if (spatialLayers.length === 0) {
    throw new BadRequestException(
      'Source data layer has no spatial sublayers; buffer needs geometry to operate on',
    );
  }
  if (layerKey === undefined) {
    if (spatialLayers.length === 1) {
      const only = spatialLayers[0]!;
      return { id: only.id, fields: only.fields ?? [] };
    }
    throw new BadRequestException(
      'derived_layer.source.layerKey is required because the source has multiple sublayers',
    );
  }
  const match = spatialLayers.find((l) => l.id === layerKey);
  if (!match) {
    throw new BadRequestException(
      `derived_layer.source.layerKey "${layerKey}" does not match any sublayer of the source`,
    );
  }
  return { id: match.id, fields: match.fields ?? [] };
}

/**
 * Read the FeatureField list from a v1 / v2 data_layer's `data`
 * blob. v3 sources do NOT come through here; they go through
 * `resolveSublayer` so the schema is read from the specific
 * sublayer the recipe targets. Kept on the v2 path because top-
 * level `fields` is the canonical place that schema lives in v2.
 */
export function readSourceSchema(data: unknown): FeatureField[] {
  if (!data || typeof data !== 'object') return [];
  const d = data as { fields?: unknown };
  if (Array.isArray(d.fields)) {
    return d.fields.filter(
      (f): f is FeatureField =>
        !!f && typeof f === 'object' && typeof (f as { name?: unknown }).name === 'string',
    );
  }
  return [];
}

/**
 * Pad a [west, south, east, north] bbox outward by `reachMeters`,
 * approximating using a single meters-per-degree constant. Returns
 * empty array when the input bbox is empty / malformed (matching the
 * `Item.bbox` convention for "no spatial footprint yet").
 */
export function padBboxByMeters(
  bbox: number[],
  reachMeters: number,
): number[] {
  if (
    !Array.isArray(bbox) ||
    bbox.length !== 4 ||
    !bbox.every((n) => Number.isFinite(n))
  ) {
    return [];
  }
  if (reachMeters <= 0) return [...bbox];
  const padding = reachMeters * DEGREES_PER_METER;
  return [
    bbox[0]! - padding,
    bbox[1]! - padding,
    bbox[2]! + padding,
    bbox[3]! + padding,
  ];
}
