// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Item } from '@prisma/client';
import {
  DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
  type DerivedLayerData,
  type FeatureField,
  type ToolStep,
} from '@gratis-gis/shared-types';

import { PrismaService } from '../prisma/prisma.service.js';
import {
  dataLayerScope,
  dataLayerSourceSqlFragment,
} from '../engine/data-layer.js';
import { getGeneratorForStep } from './tools/registry.js';
import type { ToolEnrichContext } from './tools/types.js';

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
 * Maximum depth of derived_layer chaining (#78).  A layer can have
 * a derived_layer source which itself has a derived_layer source,
 * and so on; cap the chain at 5 to bound peak planning cost and
 * catch runaway-recursion configurations early.  In practice the
 * deepest realistic chain is 2-3 (raw -> cleaned -> aggregated).
 */
const MAX_CHAIN_DEPTH = 5;

/**
 * Degrees of latitude per meter. A degree of longitude is shorter by
 * cos(latitude), so the longitude pad is divided by that (see
 * padBboxDegrees). Using this one constant for both axes padded too
 * little east and west everywhere off the equator.
 */
const DEGREES_PER_METER = 1 / 111_320;

/**
 * Tools whose output row depends only on its own input row (plus, for
 * the two-input tools, the other layer, which no bbox touches). A
 * `?bbox` can be applied to the leaf before these. Any other tool
 * (dissolve, aggregate, top-n, count sampling, nearest neighbour,
 * contour) answers over the whole set, so prefiltering to the view
 * would change its answer.
 */
const ROW_LOCAL_TOOLS = new Set<string>([
  'buffer',
  'centroid',
  'convex-hull',
  'bbox',
  'simplify',
  'vertices',
  'densify',
  'fishnet',
  'calculate-geometry',
  'calculate-field',
  'filter',
  'spatial-join',
  'spatial-filter',
  'clip',
  'erase',
]);

function isRowLocalStep(step: ToolStep): boolean {
  if (step.tool === 'random-sample') {
    return (step.params as { mode?: string }).mode !== 'count';
  }
  return ROW_LOCAL_TOOLS.has(step.tool);
}

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
      (source.kind !== 'data_layer' && source.kind !== 'derived_layer') ||
      typeof source.itemId !== 'string' ||
      source.itemId.length === 0
    ) {
      throw new BadRequestException(
        'derived_layer.source must be { kind: "data_layer" | "derived_layer", itemId: <uuid> }',
      );
    }
    if (source.itemId !== sourceItem.id) {
      throw new BadRequestException(
        'derived_layer.source.itemId must match the resolved source item',
      );
    }
    if (sourceItem.type !== source.kind) {
      throw new BadRequestException(
        `derived_layer.source.itemId must reference a ${source.kind} item (got ${sourceItem.type})`,
      );
    }

    // For derived_layer sources (#78): walk the chain to detect
    // cycles and depth-cap, then read schema + bbox from the
    // source's persisted recipe.  layerKey is not meaningful for a
    // derived_layer source (a derived layer has a single output),
    // so reject it explicitly to surface the misconfiguration.
    let sublayer: { id: string; fields: FeatureField[] } | null = null;
    let sourceSchemaForChain: FeatureField[] | null = null;
    let sourceBboxForChain: number[] | null = null;
    if (source.kind === 'derived_layer') {
      if (typeof source.layerKey === 'string' && source.layerKey.length > 0) {
        throw new BadRequestException(
          'derived_layer.source.layerKey is not valid for a derived_layer source (a derived layer has a single output)',
        );
      }
      const chain = await this.walkSourceChain(sourceItem.id);
      if (chain.depth > MAX_CHAIN_DEPTH) {
        throw new BadRequestException(
          `derived_layer source chain exceeds the maximum depth of ${MAX_CHAIN_DEPTH}; consider materialising an intermediate layer`,
        );
      }
      // The source's recipe has a cached outputSchema (validate path
      // recomputes it on every save), so we can read it without
      // re-walking the parent's pipeline.
      const sourceData = sourceItem.data as unknown as DerivedLayerData | null;
      if (
        !sourceData ||
        sourceData.version !== 1 ||
        !Array.isArray(sourceData.outputSchema)
      ) {
        throw new BadRequestException(
          'derived_layer source has no cached outputSchema; re-save the source layer before chaining',
        );
      }
      sourceSchemaForChain = sourceData.outputSchema;
      sourceBboxForChain = Array.isArray(sourceData.bbox)
        ? sourceData.bbox
        : null;
    } else {
      // v3 multi-layer items split features across one PostGIS table
      // per sublayer, so the recipe MUST name which sublayer to
      // derive from.  v2 single-table items have no sublayer, so
      // layerKey must be absent.  Reject both directions explicitly:
      // a missing layerKey on a v3 source would silently query a
      // non-existent table, and a layerKey on a v2 source would imply
      // structure that isn't there.
      const sourceVersion = readSourceVersion(sourceItem.data);
      sublayer = resolveSublayer(
        sourceItem.data,
        sourceVersion,
        typeof source.layerKey === 'string' ? source.layerKey : undefined,
      );
    }

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
    // from the resolved sublayer for v3, or top-level fields for v2,
    // or the parent recipe's cached outputSchema for a derived_layer
    // source.
    const sourceSchema: FeatureField[] = sourceSchemaForChain
      ? sourceSchemaForChain
      : sublayer
        ? sublayer.fields
        : readSourceSchema(sourceItem.data);
    const resolvedSource: DerivedLayerData['source'] = {
      kind: source.kind as 'data_layer' | 'derived_layer',
      itemId: source.itemId as string,
      ...(sublayer ? { layerKey: sublayer.id } : {}),
    };
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
      const validated = await this.resolveOtherSourceLayer(
        generator.validate((stepRaw as { params?: unknown }).params, {
          sourceSchema: schema,
        }),
        i,
      );
      // Async enrichment hook: tools fill in any caches the recipe
      // needs (buffer's field-mode `cachedMaxMeters`). Only fired at
      // save time; reads trust the persisted shape.
      const enrichedParams = generator.enrich
        ? await generator.enrich(
            validated,
            await this.enrichContext(
              resolvedSource,
              sourceItem.data,
              validatedPipeline,
              schema,
            ),
          )
        : validated;
      schema = generator.outputSchema(schema, enrichedParams);
      totalReachMeters += generator.outwardReachMeters(enrichedParams);
      validatedPipeline.push({ tool, params: enrichedParams } as ToolStep);
    }

    // bbox comes from the chained source's recipe (already padded
    // by ancestor reach) or the data_layer's stored extent.  Either
    // way we pad it again by this layer's own outward reach so the
    // map render pulls features near the edge of the source extent.
    const baseBboxRaw =
      source.kind === 'derived_layer'
        ? (sourceBboxForChain ?? [])
        : Array.isArray(sourceItem.bbox)
          ? sourceItem.bbox
          : [];
    const bbox = padBboxByMeters(baseBboxRaw, totalReachMeters);

    return {
      version: 1,
      source: resolvedSource,
      pipeline: validatedPipeline,
      featureLimit,
      outputSchema: schema,
      bbox,
    };
  }

  /**
   * Pin a two-input step's other layer to a real sublayer, by the same
   * rules as the primary source. Clip, erase, join and spatial filter
   * fall back to the `default` scope when the key is missing or
   * misspelled, and a v3 item has no rows there: clip dropped every
   * feature, erase kept them all, and nothing said why.
   */
  private async resolveOtherSourceLayer<T>(params: T, index: number): Promise<T> {
    const other = (params as { otherSource?: unknown } | null)?.otherSource as
      | { kind?: unknown; itemId?: unknown; layerKey?: unknown }
      | undefined;
    if (!other || other.kind !== 'data_layer' || typeof other.itemId !== 'string') {
      return params;
    }
    const item = await this.prisma.item.findUnique({
      where: { id: other.itemId },
      select: { data: true },
    });
    // Missing items are reported by the access checks the caller runs.
    // Only v3 items have sublayer keys; older shapes read `default`.
    if (!item || readSourceVersion(item.data) !== 3) return params;
    let sub: { id: string } | null;
    try {
      sub = resolveSublayer(
        item.data,
        3,
        typeof other.layerKey === 'string' ? other.layerKey : undefined,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(
        `derived_layer.pipeline[${index}].params.otherSource: ${msg.replace(/^derived_layer\.source\.layerKey/, 'layerKey')}`,
      );
    }
    if (!sub || sub.id === other.layerKey) return params;
    return {
      ...params,
      otherSource: { ...other, layerKey: sub.id },
    } as T;
  }

  /**
   * Context for a step's `enrich` hook. The hook queries the rows the
   * step will really receive: the source run through every earlier
   * step, and through the parent recipe when the source is another
   * derived layer. Handing it the raw source table cached the wrong
   * MAX (or 0, for a chained source), and buffer by field then drew
   * zero-width buffers with no error.
   */
  private async enrichContext(
    source: DerivedLayerData['source'],
    sourceData: unknown,
    earlierSteps: ToolStep[],
    schema: FeatureField[],
  ): Promise<ToolEnrichContext> {
    const sourceParams: unknown[] = [];
    const { ctes, finalAlias } = await this.composeReadCtes({
      layerData: {
        version: 1,
        source,
        pipeline: earlierSteps,
        featureLimit: 1,
        outputSchema: [],
        bbox: [],
      },
      depth: 0,
      params: sourceParams,
      opts: {},
      visited: new Set(),
      sourceData,
    });
    return {
      sourceSchema: schema,
      sourceTable: `(WITH ${ctes.join(', ')} SELECT global_id, geom, properties FROM ${finalAlias}) AS source_features`,
      sourceParamCount: sourceParams.length,
      queryRaw: <T = unknown>(sql: string, ...p: unknown[]) =>
        this.prisma.$queryRawUnsafe<T[]>(sql, ...sourceParams, ...p),
    };
  }

  /**
   * Walk a chain of derived_layer sources starting at `startId`.
   * Throws BadRequestException on cycle / orphan / non-derived
   * member; returns the depth (1 = this layer; chain of length N
   * has depth N) when the chain is clean.
   *
   * Cycle detection: we track visited item ids and throw if we ever
   * revisit one.  The walk stops at the first non-derived_layer
   * (data_layer) ancestor; that is the chain's root and is valid
   * regardless of depth as long as we stayed under MAX_CHAIN_DEPTH
   * derived_layer hops.
   *
   * Returns the rolled-up depth count so the caller can apply the
   * MAX_CHAIN_DEPTH guard without re-walking.
   */
  private async walkSourceChain(
    startId: string,
  ): Promise<{ depth: number }> {
    const visited = new Set<string>([startId]);
    let currentId: string | null = startId;
    let depth = 1;
    while (currentId !== null) {
      const id: string = currentId;
      const node: {
        id: string;
        type: string;
        data: unknown;
        deletedAt: Date | null;
      } | null = await this.prisma.item.findUnique({
        where: { id },
        select: { id: true, type: true, data: true, deletedAt: true },
      });
      if (!node || node.deletedAt !== null) {
        throw new BadRequestException(
          `derived_layer source chain references missing or trashed item ${id}`,
        );
      }
      if (node.type === 'data_layer') {
        return { depth };
      }
      if (node.type !== 'derived_layer') {
        throw new BadRequestException(
          `derived_layer source chain links through a ${node.type} item; only data_layer and derived_layer are allowed`,
        );
      }
      const parentSource = (
        node.data as { source?: { itemId?: unknown } } | null
      )?.source;
      const parentId: string | null =
        parentSource && typeof parentSource.itemId === 'string'
          ? parentSource.itemId
          : null;
      if (!parentId) {
        throw new BadRequestException(
          `derived_layer source ${id} has no source itemId`,
        );
      }
      if (visited.has(parentId)) {
        throw new BadRequestException(
          `derived_layer source chain has a cycle through ${parentId}`,
        );
      }
      visited.add(parentId);
      depth += 1;
      if (depth > MAX_CHAIN_DEPTH) {
        return { depth };
      }
      currentId = parentId;
    }
    return { depth };
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
    if (!sourceItem || sourceItem.id !== data.source.itemId) {
      return { type: 'FeatureCollection', features: [] };
    }
    // The source must be either a data_layer (the historic single-
    // source case) or a derived_layer (#78 chaining).  Caller has
    // already done the ACL check on every item in the chain.
    if (sourceItem.type !== data.source.kind) {
      return { type: 'FeatureCollection', features: [] };
    }

    // For data_layer roots, gate on PostGIS-backed storage; v1 inline
    // -GeoJSON sources have no table to read.  For derived_layer
    // sources we defer the check to the chain walk, which will hit a
    // data_layer root eventually.
    if (sourceItem.type === 'data_layer') {
      const storageType = (sourceItem.data as { storageType?: string } | null)
        ?.storageType;
      if (storageType !== 'postgis') {
        return { type: 'FeatureCollection', features: [] };
      }
    }

    const queryParams: unknown[] = [];
    const { ctes, finalAlias, bboxDeferred } = await this.composeReadCtes({
      layerData: data,
      depth: 0,
      params: queryParams,
      opts,
      visited: new Set([item.id]),
      sourceData: sourceItem.data,
    });

    // A whole-set step ran over every row, so the view filter goes on
    // its output rather than on the source.
    let viewFilter = '';
    if (bboxDeferred && opts.bbox) {
      queryParams.push(...opts.bbox);
      const b = queryParams.length;
      viewFilter = `AND ST_Intersects(geom, ST_MakeEnvelope($${b - 3}, $${b - 2}, $${b - 1}, $${b}, 4326))`;
    }

    queryParams.push(data.featureLimit);
    const limitParam = queryParams.length;

    const sql = `
      WITH ${ctes.join(', ')}
      SELECT global_id, ST_AsGeoJSON(geom) AS geom, properties
      FROM ${finalAlias}
      WHERE geom IS NOT NULL ${viewFilter}
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
   * Recursively compose the CTE chain for a derived_layer's read
   * path (#78).  Each invocation produces a list of CTEs for one
   * layer's pipeline; when the layer's source is itself a
   * derived_layer, the recursive call's CTEs prepend the result so
   * the deepest ancestor sits first and each subsequent ancestor
   * (and this layer) appends afterward.
   *
   * CTE naming uses a depth-prefixed scheme: `d0_source`, `d0_step_1`,
   * `d0_step_2`, ..., `d1_source`, `d1_step_1`, ..., so adjacent
   * derived layers don't collide on `step_N` aliases.  The final
   * alias returned by the recursive call is the input to the next
   * level up.
   *
   * Bbox / temporal / boundary filters apply ONLY to the data_layer
   * root (depth = leaf).  Ancestor derived layers run their full
   * pipelines against the unfiltered downstream truth; the filter
   * is applied at the start of the source CTE because pushing it
   * down to every step would require each generator to understand
   * filter semantics.
   */
  private async composeReadCtes(args: {
    layerData: DerivedLayerData;
    depth: number;
    params: unknown[];
    opts: {
      bbox?: [number, number, number, number];
      at?: string;
      boundaryClipId?: string;
    };
    visited: Set<string>;
    /** The source item's data when the caller already has it. */
    sourceData?: unknown;
    /** Outward reach of every level above this one, in meters. */
    reachAbove?: number;
  }): Promise<{ ctes: string[]; finalAlias: string; bboxDeferred: boolean }> {
    const { layerData, depth, params, visited } = args;
    let opts = args.opts;
    // A whole-set step here must see every row, so nothing below it
    // may be cut to the view. The caller applies the bbox to the
    // final output instead.
    let bboxDeferred = false;
    if (opts.bbox && !layerData.pipeline.every(isRowLocalStep)) {
      const { bbox: _deferred, ...rest } = opts;
      void _deferred;
      opts = rest;
      bboxDeferred = true;
    }
    // Schema of the rows entering this layer's pipeline. Tools that
    // compile expressions need it to cast numeric properties.
    let inputSchema: FeatureField[] = [];
    const prefix = `d${depth}`;

    // Sum outward reach across this layer's pipeline; used (only at
    // the root) to pad the bbox prefilter so the leaf source pulls
    // features near the edge of the requested view.
    let layerReachMeters = 0;
    for (const step of layerData.pipeline) {
      const generator = getGeneratorForStep(step);
      layerReachMeters += generator.outwardReachMeters(
        generator.validate(step.params),
      );
    }

    let sourceAlias: string;
    let ctes: string[];

    if (layerData.source.kind === 'derived_layer') {
      // Recurse into the parent derived_layer.  Cycle detection
      // here is belt-and-suspenders: validateAndEnrich rejects
      // cycles at save time, but a stale row could still leak one
      // through the read path.
      if (visited.has(layerData.source.itemId)) {
        throw new BadRequestException(
          `derived_layer source chain has a cycle through ${layerData.source.itemId}`,
        );
      }
      const next = new Set(visited);
      next.add(layerData.source.itemId);
      const parent = await this.prisma.item.findUnique({
        where: { id: layerData.source.itemId },
        select: { id: true, type: true, data: true, deletedAt: true },
      });
      if (
        !parent ||
        parent.deletedAt !== null ||
        parent.type !== 'derived_layer'
      ) {
        throw new BadRequestException(
          'derived_layer chained source is missing or no longer a derived_layer',
        );
      }
      const parentData = parent.data as unknown as DerivedLayerData | null;
      if (!parentData || parentData.version !== 1) {
        throw new BadRequestException(
          'derived_layer chained source has an unrecognised recipe shape',
        );
      }
      if (depth + 1 > MAX_CHAIN_DEPTH) {
        throw new BadRequestException(
          `derived_layer source chain exceeds the maximum depth of ${MAX_CHAIN_DEPTH}`,
        );
      }
      const inner = await this.composeReadCtes({
        layerData: parentData,
        depth: depth + 1,
        params,
        opts,
        visited: next,
        reachAbove: (args.reachAbove ?? 0) + layerReachMeters,
      });
      if (inner.bboxDeferred) bboxDeferred = true;
      ctes = inner.ctes;
      sourceAlias = inner.finalAlias;
      inputSchema = Array.isArray(parentData.outputSchema)
        ? parentData.outputSchema
        : [];
    } else {
      // data_layer leaf: build the engine's current-truth projection
      // with the request's bbox / temporal / boundary filters
      // applied as predicates.  Mirrors the historical single-source
      // code path exactly.
      //
      // The temporal window goes into the fragment's collapse
      // conditions (it defines WHICH history is visible); the
      // spatial predicates go into content conditions so the
      // fragment evaluates them against the collapsed latest row.
      // Passing spatial predicates as collapse conditions was the
      // ghost bug: a feature edited out of the bbox (or deleted;
      // tombstones carry NULL geom and never match a spatial
      // clause) kept surfacing through its old in-bbox version.
      const sourceScope = layerData.source.layerKey
        ? dataLayerScope(layerData.source.itemId, layerData.source.layerKey)
        : dataLayerScope(layerData.source.itemId, 'default');
      const leafData =
        args.sourceData !== undefined
          ? args.sourceData
          : (
              await this.prisma.item.findUnique({
                where: { id: layerData.source.itemId },
                select: { data: true },
              })
            )?.data;
      inputSchema = leafSchema(leafData, layerData.source.layerKey);
      const collapseConditions: string[] = [];
      const contentConditions: string[] = [];
      if (opts.at) {
        const ts = new Date(opts.at);
        if (!isNaN(ts.getTime())) {
          params.push(ts.toISOString());
          const p = params.length;
          collapseConditions.push(
            `valid_from <= $${p}::timestamptz AND (valid_to IS NULL OR valid_to > $${p}::timestamptz)`,
          );
        }
      } else {
        collapseConditions.push('valid_to IS NULL');
      }
      if (opts.bbox) {
        // The leaf is the only place the bbox is applied, so it is
        // padded by the reach of every level above it as well as this
        // one: a buffer two levels up still needs its halo here.
        const [minX, minY, maxX, maxY] = padBboxDegrees(
          opts.bbox,
          (args.reachAbove ?? 0) + layerReachMeters,
        );
        params.push(minX, minY, maxX, maxY);
        const b = params.length;
        contentConditions.push(
          `geom IS NOT NULL AND ST_Intersects(geom, ST_MakeEnvelope($${b - 3}, $${b - 2}, $${b - 1}, $${b}, 4326))`,
        );
      }
      if (opts.boundaryClipId) {
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
          params.push(JSON.stringify(g));
          const p = params.length;
          contentConditions.push(
            `geom IS NOT NULL AND ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON($${p}::text), 4326))`,
          );
        }
      }

      sourceAlias = `${prefix}_source`;
      ctes = [
        `${sourceAlias} AS (${dataLayerSourceSqlFragment(sourceScope, {
          collapseConditions,
          contentConditions,
        })})`,
      ];
    }

    // Apply this layer's own pipeline on top of whatever input
    // alias the source resolution produced.  The step-N CTE names
    // are depth-prefixed so adjacent levels never collide.
    let inputAlias = sourceAlias;
    let schema = inputSchema;
    for (let i = 0; i < layerData.pipeline.length; i++) {
      const step = layerData.pipeline[i]!;
      const generator = getGeneratorForStep(step);
      const stepParams = generator.validate(step.params);
      const fragment = generator.toSql(inputAlias, stepParams, params.length, {
        inputSchema: schema,
      });
      const cteName = `${prefix}_step_${i + 1}`;
      ctes.push(`${cteName} AS (${fragment.sql})`);
      params.push(...fragment.params);
      inputAlias = cteName;
      schema = generator.outputSchema(schema, stepParams);
    }

    return { ctes, finalAlias: inputAlias, bboxDeferred };
  }

  /**
   * Preview a draft recipe (#81).  Runs the pipeline through step
   * `upTo` inclusive against the resolved source and returns a
   * small sample of output features + the computed output schema +
   * a row-count estimate (capped by the preview limit).
   *
   * Used by the wizard's per-step Preview buttons so authors can
   * see what each step produces before saving.  The recipe doesn't
   * have to be a saved derived_layer item -- the caller passes the
   * draft directly.  Caller is responsible for verifying read
   * access on the source.
   */
  async previewRecipe(args: {
    source: DerivedLayerData['source'];
    pipeline: ToolStep[];
    sourceItem: Pick<Item, 'id' | 'type' | 'data' | 'bbox'>;
    upTo: number;
    limit: number;
    /**
     * Optional ISO timestamp -- when set, the preview runs against
     * the source's bitemporal "current truth" as of that moment.
     * Lets authors compare "what would this recipe have produced
     * yesterday vs. now" without saving + reloading.  Mirrors the
     * `at` query param on the geojson controller.
     */
    at?: string;
  }): Promise<{
    rowCount: number;
    truncated: boolean;
    sample: Array<{
      id: string | number | null;
      geometry: unknown;
      properties: Record<string, unknown>;
    }>;
    outputSchema: FeatureField[];
  }> {
    if (args.pipeline.length === 0) {
      return {
        rowCount: 0,
        truncated: false,
        sample: [],
        outputSchema: [],
      };
    }
    // Same step limit as save: preview runs the same SQL, so a longer
    // pipeline here was a way to send thousands of CTE steps.
    if (args.pipeline.length > MAX_PIPELINE_STEPS) {
      throw new BadRequestException(
        `derived_layer.pipeline must not exceed ${MAX_PIPELINE_STEPS} steps`,
      );
    }
    const stop = Math.min(args.upTo, args.pipeline.length - 1);
    const sliced = args.pipeline.slice(0, stop + 1);
    const previewLimit = Math.max(1, Math.min(args.limit, 50));

    if (
      args.sourceItem.type !== 'data_layer' &&
      args.sourceItem.type !== 'derived_layer'
    ) {
      throw new BadRequestException(
        'derived-layer preview: source must be a data_layer or derived_layer item',
      );
    }
    if (args.sourceItem.type !== args.source.kind) {
      throw new BadRequestException(
        'derived-layer preview: source.kind must match the resolved source item type',
      );
    }

    // Compute the output schema by walking the validator chain --
    // mirrors what validateAndEnrich does at save time, but without
    // the async enrich pass (the cached values aren't load-bearing
    // for read-time SQL emission; tools that depend on them treat
    // missing values as defaults).
    let schema: FeatureField[];
    if (args.sourceItem.type === 'derived_layer') {
      const sourceData = args.sourceItem.data as unknown as
        | DerivedLayerData
        | null;
      if (
        !sourceData ||
        sourceData.version !== 1 ||
        !Array.isArray(sourceData.outputSchema)
      ) {
        throw new BadRequestException(
          'derived-layer preview: chained source has no cached outputSchema',
        );
      }
      schema = sourceData.outputSchema;
    } else {
      const sourceVersion = readSourceVersion(args.sourceItem.data);
      const sublayer = resolveSublayer(
        args.sourceItem.data,
        sourceVersion,
        typeof args.source.layerKey === 'string'
          ? args.source.layerKey
          : undefined,
      );
      schema = sublayer
        ? sublayer.fields
        : readSourceSchema(args.sourceItem.data);
    }
    // Enrich as save does, so a buffer by field preview uses the real
    // cap instead of the 0 the wizard sends.
    const enrichedSteps: ToolStep[] = [];
    for (const step of sliced) {
      const generator = getGeneratorForStep(step);
      const validated = generator.validate(step.params, {
        sourceSchema: schema,
      });
      const enriched = generator.enrich
        ? await generator.enrich(
            validated,
            await this.enrichContext(
              args.source,
              args.sourceItem.data,
              enrichedSteps,
              schema,
            ),
          )
        : validated;
      enrichedSteps.push({ tool: step.tool, params: enriched } as ToolStep);
      schema = generator.outputSchema(schema, enriched);
    }

    // Compose the SQL via the same path getGeoJson uses, but with
    // the truncated pipeline and a slim preview limit (+1 so we
    // can detect "more rows available beyond the preview cap").
    const fakeRecipe: DerivedLayerData = {
      version: 1,
      source: args.source,
      pipeline: enrichedSteps,
      featureLimit: previewLimit + 1,
      outputSchema: schema,
      bbox: [],
    };
    const fakeItem = {
      id: 'preview-recipe',
      type: 'derived_layer' as const,
      data: fakeRecipe as unknown as Prisma.JsonValue,
      bbox: [] as unknown as number[] | [],
    } as unknown as Item;

    const fc = await this.getGeoJson(
      fakeItem,
      {
        id: args.sourceItem.id,
        type: args.sourceItem.type as 'data_layer' | 'derived_layer',
        data: args.sourceItem.data,
      },
      args.at ? { at: args.at } : {},
    );
    const allRows = fc.features as Array<{
      type: 'Feature';
      id?: string | number;
      geometry: unknown;
      properties: Record<string, unknown>;
    }>;
    const truncated = allRows.length > previewLimit;
    const sample = allRows.slice(0, previewLimit).map((f) => ({
      id: (f.id ?? null) as string | number | null,
      geometry: f.geometry,
      properties: f.properties ?? {},
    }));
    return {
      rowCount: truncated ? previewLimit : allRows.length,
      truncated,
      sample,
      outputSchema: schema,
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
    const sourceScope = data.source.layerKey
      ? dataLayerScope(sourceItem.id, data.source.layerKey)
      : dataLayerScope(sourceItem.id, 'default');
    const queryParams: unknown[] = [];
    // Same split as composeReadCtes: temporal window collapses,
    // spatial predicate re-checks against the collapsed latest row.
    const collapseConditions: string[] = [];
    const contentConditions: string[] = [];

    if (opts.at) {
      queryParams.push(opts.at);
      const p = queryParams.length;
      collapseConditions.push(
        `valid_from <= $${p}::timestamptz AND (valid_to IS NULL OR valid_to > $${p}::timestamptz)`,
      );
    } else {
      collapseConditions.push('valid_to IS NULL');
    }

    if (opts.bbox) {
      const [minX, minY, maxX, maxY] = padBboxDegrees(
        opts.bbox,
        totalReachMeters,
      );
      queryParams.push(minX, minY, maxX, maxY);
      const b = queryParams.length;
      contentConditions.push(
        `geom IS NOT NULL AND ST_Intersects(geom, ST_MakeEnvelope($${b - 3}, $${b - 2}, $${b - 1}, $${b}, 4326))`,
      );
    }

    const ctes: string[] = [
      `source AS (${dataLayerSourceSqlFragment(sourceScope, {
        collapseConditions,
        contentConditions,
      })})`,
    ];
    let inputAlias = 'source';
    let schema = leafSchema(sourceItem.data, data.source.layerKey);
    for (let i = 0; i < data.pipeline.length; i++) {
      const step = data.pipeline[i]!;
      const generator = getGeneratorForStep(step);
      const params = generator.validate(step.params);
      const fragment = generator.toSql(
        inputAlias,
        params,
        queryParams.length,
        { inputSchema: schema },
      );
      const cteName = `step_${i + 1}`;
      ctes.push(`${cteName} AS (${fragment.sql})`);
      queryParams.push(...fragment.params);
      inputAlias = cteName;
      schema = generator.outputSchema(schema, params);
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
 * Field schema of a data layer source at read time: the named v3
 * sublayer's fields, or the top-level v2 fields. Never throws: a
 * source that no longer resolves just yields no types, and the tools
 * then treat every field as text, as before.
 */
export function leafSchema(data: unknown, layerKey?: string): FeatureField[] {
  try {
    const sub = resolveSublayer(data, readSourceVersion(data), layerKey);
    return sub ? sub.fields : readSourceSchema(data);
  } catch {
    return readSourceSchema(data);
  }
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
  return padBboxDegrees(bbox as [number, number, number, number], reachMeters);
}

/**
 * Pad a bbox by `reachMeters` on every side. Latitude uses the plain
 * meters-per-degree figure; longitude divides it by cos(latitude) at
 * the box's most poleward edge, where a degree is shortest, so the pad
 * is never short. Latitude is floored at 89 degrees for the cosine so
 * the pad stays finite near the poles.
 */
export function padBboxDegrees(
  bbox: readonly number[],
  reachMeters: number,
): [number, number, number, number] {
  const [minX, minY, maxX, maxY] = bbox as [number, number, number, number];
  if (!(reachMeters > 0)) return [minX, minY, maxX, maxY];
  const latPad = reachMeters * DEGREES_PER_METER;
  const south = minY - latPad;
  const north = maxY + latPad;
  const poleward = Math.min(89, Math.max(Math.abs(south), Math.abs(north)));
  const lonPad = latPad / Math.cos((poleward * Math.PI) / 180);
  return [minX - lonPad, south, maxX + lonPad, north];
}
