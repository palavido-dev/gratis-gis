// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  DistanceRef,
  FeatureSourceValue,
  OsmRelationalQueryAction,
  OsmTagFilter,
  PredicateRef,
  RecipeAction,
  RelationalDistance,
  SourceRef,
  SpatialPredicate,
  ToolItemData,
  ToolParameter,
  ToolStep,
  WorkflowGraph,
} from '@gratis-gis/shared-types';
import {
  DEFAULT_TOOL_SELECTION_LIMIT,
  topologicalSort,
} from '@gratis-gis/shared-types';

import {
  dataLayerScope,
  dataLayerSourceSqlFragment,
} from '../engine/data-layer.js';
import { ItemsService } from '../items/items.service.js';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { getGeneratorForStep } from '../derived-layers/tools/registry.js';
import { OsmService } from '../osm/osm.service.js';
import type { OsmGeoJsonFeature } from '../osm/osm-to-geojson.js';
import { getOsmPreset } from '../osm/preset-catalog.js';

/**
 * Narrow GeoJSON-geometry shape used by post-fetch spatial passes
 * (#151 corridor filter, future polygon-tight filter).  Only the
 * fields the PostGIS helper inserts are typed; the rest of the
 * payload passes through unchanged.
 */
interface GeoJsonGeometryLike {
  type: string;
  coordinates: unknown;
}

/**
 * Per-parameter resolved value: the runtime-supplied input merged
 * with the parameter's binding-defined default.  The recipe runner
 * resolves every parameter exactly once at the top of a run, then
 * walks the pipeline substituting these values into step params.
 */
export type ResolvedValue =
  | { kind: 'feature-source'; value: FeatureSourceValue }
  | { kind: 'predicate'; value: SpatialPredicate }
  | { kind: 'distance'; meters: number }
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string }
  | {
      kind: 'osm-feature';
      presetIds: string[];
      tagFilters?: OsmTagFilter[];
      /** #101: per-recipe TTL override in minutes (0 = always fresh). */
      ttlMinutes?: number;
    }
  | {
      kind: 'point';
      /** WGS-84 longitude, decimal degrees. */
      lng: number;
      /** WGS-84 latitude, decimal degrees. */
      lat: number;
    };

/**
 * Untrusted shape coming off the wire under `parameters[name]`.
 * The runner translates it to a ResolvedValue or rejects it.  OSM
 * inputs carry the user's runtime picks (which preset ids + which
 * tag filters); hardcoded osm-feature parameters resolve from
 * their binding without an input row.
 */
export type ToolRunInput =
  | FeatureSourceValue
  | SpatialPredicate
  | number
  | string
  | {
      kind: 'osm-feature-input';
      presetIds: string[];
      tagFilters?: OsmTagFilter[];
      /** #101: per-recipe TTL override in minutes (0 = always fresh). */
      ttlMinutes?: number;
    };

export interface ToolRunRequest {
  parameters: Record<string, ToolRunInput>;
}

export interface ToolSelectionResult {
  output: {
    kind: 'selection';
    /** Resolved layer (data_layer / derived_layer item id + sublayer
     *  key) the selection applies to.  Mirrors the host map's layer
     *  identity so the client can update the right selection slot. */
    layer: { itemId: string; layerKey?: string };
    /** Matching feature ids in the selection layer. */
    featureIds: Array<string | number>;
    /** True when more rows existed than the cap; the UI surfaces a
     *  banner so the user knows the selection is incomplete. */
    truncated: boolean;
  };
}

export interface ToolOsmOverlayResult {
  output: {
    kind: 'osm-features-overlay';
    /** GeoJSON features (Points / LineStrings / Polygons /
     *  MultiPolygons) the host map should render as a transient
     *  overlay.  Always carries the OSM attribution string the UI
     *  must surface alongside the rendered features (ODbL). */
    features: OsmGeoJsonFeature[];
    /** © OpenStreetMap contributors string the runtime surfaces
     *  next to the overlay. */
    attribution: string;
    /** Total fetched count (pre any post-filter steps).  Matches
     *  `features.length` in v1 since the pipeline either keeps or
     *  drops features, no post-fetch attribute decoration yet. */
    featureCount: number;
    /** True when the underlying Overpass response hit the
     *  per-query cap.  UI banner so the user knows to tighten the
     *  AOI / filters. */
    truncated: boolean;
    /** Human-readable labels of the OSM presets that were actually
     *  queried (resolved from the catalog at run time so the client
     *  doesn't need its own copy).  Used by the runtime to title the
     *  result MapLayer with what the user searched for (e.g.
     *  "School, Park") instead of the tool's generic name.  Empty
     *  array when no presets matched the resolver (extremely rare;
     *  the picker constrains to valid ids). */
    presetLabels: string[];
  };
}

/**
 * Relational OSM query result.  Three feature collections the
 * runtime turns into three host-map MapLayer entries: the surviving
 * anchors, the proximity buffers, and the supporting condition
 * features that contributed to at least one match.  The condition
 * labels drive layer titling on the client (e.g. "School near Park
 * and Liquor store").
 */
export interface ToolOsmRelationalResult {
  output: {
    kind: 'osm-relational-result';
    anchor: {
      preset: string;
      presetLabel: string;
      features: OsmGeoJsonFeature[];
      /** Pre-buffer count -- how many candidate anchors Overpass
       *  returned.  Surfaced in the result chip so users see
       *  "Found 12 schools matching 2 conditions out of 47
       *  candidates" not just the bare survivor count. */
      candidateCount: number;
    };
    conditions: Array<{
      preset: string;
      presetLabel: string;
      distanceMeters: number;
      candidateCount: number;
      /** Per-condition supporting features.  Surfaced so the
       *  bearing-arc viz on the client (#153 follow-up) can draw
       *  fans rooted at the right condition's features without
       *  re-classifying the flat list. */
      supporting: OsmGeoJsonFeature[];
    }>;
    /** Supporting condition features that contributed to at least
     *  one surviving anchor.  De-duped by osm:id so a park near
     *  two schools only appears once. */
    supporting: OsmGeoJsonFeature[];
    /** Buffer polygons (one per surviving anchor) sized at the
     *  max condition distance, for "show me the search radius"
     *  visualization.  Properties carry the anchor's id + radius. */
    buffers: OsmGeoJsonFeature[];
    /** Bearings echo back so the client can render the matched
     *  angular arcs as a viz layer.  Empty array when no bearing
     *  predicates were configured. */
    bearings: Array<{
      conditionIndex: number;
      bearingDegrees: number;
      toleranceDegrees: number;
    }>;
    attribution: string;
    /** True when any of the per-preset Overpass calls hit the
     *  per-query feature cap. */
    truncated: boolean;
  };
}

export type ToolRunResult =
  | ToolSelectionResult
  | ToolOsmOverlayResult
  | ToolOsmRelationalResult;

/**
 * Tool recipe runner (#90).  Resolves runtime parameter inputs,
 * substitutes them into the pipeline's parameter references, and
 * runs the resulting concrete pipeline as SQL against PostGIS.
 *
 * v1 supports `output.kind === 'selection'`: the pipeline's final
 * CTE is projected to `global_id`, capped at `selectionLimit`, and
 * returned to the caller.  `derived-layer` and `data-layer` output
 * sinks land in follow-up commits.
 *
 * The runner relies on the same tool generator registry that
 * derived_layer uses for its read path.  This keeps the two
 * vocabularies in sync at the SQL-compilation layer: any step that
 * works in a derived_layer pipeline works inside a tool recipe.
 */
@Injectable()
export class RecipeRunnerService {
  private readonly logger = new Logger(RecipeRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly items: ItemsService,
    private readonly osm: OsmService,
  ) {}

  /**
   * Top-level entry point used by the controller.  Loads the tool,
   * runs the recipe, and branches on the output sink to produce
   * either a selection update or an OSM-features overlay response.
   */
  async run(
    user: AuthUser | null,
    toolId: string,
    request: ToolRunRequest,
  ): Promise<ToolRunResult> {
    // Anonymous callers can only reach this surface via @Public()
    // on the controller.  When user is null we restrict to:
    //   (1) public-access tool items, and
    //   (2) action kinds that don't touch the portal's data layers
    //       (the OSM-only surfaces).
    // Authenticated callers get the full surface with normal ACL
    // gating through ItemsService.get().
    const action = user
      ? await this.loadToolAction(user, toolId)
      : await this.loadPublicToolAction(toolId);
    if (action.kind === 'osm-relational-query') {
      return this.runOsmRelationalInternal(action, request, user);
    }
    if (action.kind === 'recipe') {
      // #157 Workflow graph: when the recipe carries a `graph`,
      // topologically sort it down to a linear pipeline before the
      // downstream runners see the action. Phase 1 ships single-
      // input nodes only, so a topo sort always produces a valid
      // linear sequence; branching multi-input nodes (join /
      // union) land in Phase 2 with their own per-node executor.
      const linearized = linearizeIfGraph(action, toolId);
      if (linearized.output.kind === 'selection') {
        if (!user) {
          throw new UnauthorizedException(
            'This tool updates a layer selection and requires sign-in.',
          );
        }
        return this.runSelectionInternal(user, toolId, linearized, request);
      }
      if (linearized.output.kind === 'osm-features-overlay') {
        // #103: thread the running user's orgId so OsmService can
        // look up the per-org Overpass endpoint override.  When
        // user is null, OsmService falls back to the env / default
        // Overpass endpoint -- anonymous viewers can still query.
        return this.runOsmOverlayInternal(linearized, request, user);
      }
      throw new BadRequestException(
        `Tool ${toolId} has an unsupported output sink: ${linearized.output.kind}`,
      );
    }
    // The union narrowed exhaustively above; this is dead code that
    // exists only so TypeScript can prove the function always
    // returns or throws.  Cast through unknown so the unreachable
    // formatter doesn't trip the `never`-narrowing diagnostic.
    const k = (action as { kind: string }).kind;
    throw new BadRequestException(
      `Tool ${toolId} has an unsupported action kind: ${k}`,
    );
  }

  /**
   * Anonymous tool-load path (#149 / #142 / #117 follow-up).
   * Fetches a tool item directly from Prisma, enforcing
   * `access='public'` + `deletedAt is null`, and returns its
   * action.  Bypasses ItemsService.get() because that gate
   * requires an AuthUser.  Throws NotFoundException for any tool
   * that isn't a runnable Tool item, isn't public, or has been
   * trashed -- deliberately indistinguishable so existence of a
   * private tool can't leak via a 403 vs 404 difference.
   */
  private async loadPublicToolAction(
    toolId: string,
  ): Promise<RecipeAction | OsmRelationalQueryAction> {
    const row = await this.prisma.item.findFirst({
      where: { id: toolId, access: 'public', deletedAt: null, type: 'tool' },
      select: { data: true },
    });
    if (!row) {
      throw new NotFoundException('Tool not found');
    }
    const data = row.data as unknown as ToolItemData | null;
    if (!data) {
      throw new BadRequestException(`Tool ${toolId} has no data blob`);
    }
    if (
      data.action.kind === 'recipe' ||
      data.action.kind === 'osm-relational-query'
    ) {
      return data.action;
    }
    throw new BadRequestException(
      `Tool ${toolId} action kind '${data.action.kind}' is not runnable anonymously`,
    );
  }

  /**
   * Run a tool recipe on behalf of `user`.  Loads the tool item
   * (gating on read), resolves the parameter values, and executes
   * the pipeline.  Throws NotFoundException if the tool doesn't
   * exist or the caller can't read it.  Throws BadRequestException
   * if the recipe shape is invalid or the request payload doesn't
   * satisfy a required parameter.
   *
   * Kept exported (alongside the new `run` entry point) for the
   * existing controller path; new callers should prefer `run()`
   * which auto-branches on the output sink.
   */
  /**
   * Load the tool item via the ACL-gated items service and return
   * its recipe action.  Throws when the item isn't a tool or doesn't
   * have a recipe action; the caller doesn't have to care about
   * which.
   */
  private async loadRecipe(
    user: AuthUser,
    toolId: string,
  ): Promise<{ recipe: RecipeAction }> {
    const tool = await this.items.get(user, toolId);
    if (tool.type !== 'tool') {
      throw new BadRequestException(`Item ${toolId} is not a tool`);
    }
    const data = tool.data as unknown as ToolItemData | null;
    if (!data || data.action.kind !== 'recipe') {
      throw new BadRequestException(
        `Tool ${toolId} does not have a recipe action`,
      );
    }
    return { recipe: data.action };
  }

  /**
   * Generalised loader: returns whatever ToolAction the tool item
   * carries (after ACL-gating the read).  Used by the `run()`
   * dispatcher so a relational-query tool doesn't have to deserialise
   * through the recipe shape.  Callers branch on action.kind.
   */
  private async loadToolAction(
    user: AuthUser,
    toolId: string,
  ): Promise<RecipeAction | OsmRelationalQueryAction> {
    const tool = await this.items.get(user, toolId);
    if (tool.type !== 'tool') {
      throw new BadRequestException(`Item ${toolId} is not a tool`);
    }
    const data = tool.data as unknown as ToolItemData | null;
    if (!data) {
      throw new BadRequestException(`Tool ${toolId} has no data blob`);
    }
    if (
      data.action.kind === 'recipe' ||
      data.action.kind === 'osm-relational-query'
    ) {
      return data.action;
    }
    throw new BadRequestException(
      `Tool ${toolId} action kind '${data.action.kind}' is not runnable via the recipe runner`,
    );
  }

  async runSelection(
    user: AuthUser,
    toolId: string,
    request: ToolRunRequest,
  ): Promise<ToolSelectionResult> {
    const { recipe } = await this.loadRecipe(user, toolId);
    return this.runSelectionInternal(user, toolId, recipe, request);
  }

  private async runSelectionInternal(
    user: AuthUser,
    toolId: string,
    recipe: RecipeAction,
    request: ToolRunRequest,
  ): Promise<ToolSelectionResult> {
    if (recipe.output.kind !== 'selection') {
      throw new BadRequestException(
        `Tool ${toolId} has an unsupported output sink: ${recipe.output.kind}`,
      );
    }

    // Resolve every parameter once up front.  Missing optional
    // parameters resolve to undefined; missing required parameters
    // throw.  The resolved map drives every substitution downstream.
    const resolved = resolveParameters(recipe.parameters, request.parameters);

    // The output's targetParameterRef names the parameter whose
    // resolved value is the layer the selection applies to.  Without
    // that, we don't know which selection slot to update.
    const target = resolved.get(recipe.output.targetParameterRef);
    if (!target || target.kind !== 'feature-source') {
      throw new BadRequestException(
        `Recipe output references parameter '${recipe.output.targetParameterRef}' but that parameter is not a feature-source`,
      );
    }
    const targetSource = target.value;
    if (targetSource.kind !== 'data_layer' && targetSource.kind !== 'derived_layer') {
      throw new BadRequestException(
        `Selection output requires a data_layer or derived_layer target; got ${targetSource.kind}`,
      );
    }
    if (!targetSource.itemId) {
      throw new BadRequestException(
        'Selection output target parameter is missing an itemId',
      );
    }

    // Read the target layer item to gate access -- a user could
    // hold read on the tool but not on the layer it operates on.
    const targetItem = await this.items.get(user, targetSource.itemId);
    if (
      targetItem.type !== 'data_layer' &&
      targetItem.type !== 'derived_layer'
    ) {
      throw new BadRequestException(
        `Selection target ${targetSource.itemId} is not a data_layer or derived_layer`,
      );
    }
    // derived_layer targets follow-up: the selection executor below
    // only handles data_layer targets in v1 because that's where the
    // engine fragment lives.  derived_layer targets need to compose
    // the source recipe's CTEs first, which is the same chain walk
    // DerivedLayersService.getGeoJson does.  Out of scope for the
    // recipe-runner MVP; revisit when extending.
    if (targetItem.type !== 'data_layer') {
      throw new BadRequestException(
        'Selection against a derived_layer is not yet supported; aim the target parameter at a data_layer',
      );
    }

    // Build CTEs: source from the target data_layer + each step.
    const layerKey = targetSource.layerKey ?? 'default';
    const sqlParams: unknown[] = [];
    const sourceScope = dataLayerScope(targetSource.itemId, layerKey);
    const sourceConditions = ['valid_to IS NULL'];
    if (
      targetSource.featureIds &&
      Array.isArray(targetSource.featureIds) &&
      targetSource.featureIds.length > 0
    ) {
      // Selection-from-current-selection workflow: the target
      // parameter resolved to "these specific features" rather than
      // "the whole layer", so we pre-restrict the source rows.
      sqlParams.push(targetSource.featureIds);
      sourceConditions.push(`entity = ANY($${sqlParams.length}::text[])`);
    }
    const sourceFragment = dataLayerSourceSqlFragment(sourceScope, {
      collapseConditions: sourceConditions,
    });

    const ctes: string[] = [`tool_source AS (${sourceFragment})`];
    let inputAlias = 'tool_source';

    // Walk the pipeline, substituting parameter refs in each step's
    // params with their resolved values, then handing the substituted
    // params to the existing tool generator.  This is the moment the
    // recipe vocabulary becomes a derived_layer-shaped pipeline.
    const concretePipeline = recipe.pipeline.map((step) =>
      substituteStep(step, resolved),
    );
    for (let i = 0; i < concretePipeline.length; i++) {
      const step = concretePipeline[i]!;
      const generator = getGeneratorForStep(step);
      const stepParams = generator.validate(step.params);
      const fragment = generator.toSql(inputAlias, stepParams, sqlParams.length);
      const cteName = `tool_step_${i + 1}`;
      ctes.push(`${cteName} AS (${fragment.sql})`);
      sqlParams.push(...fragment.params);
      inputAlias = cteName;
    }

    const cap = recipe.selectionLimit ?? DEFAULT_TOOL_SELECTION_LIMIT;
    // SELECT one row past the cap so the response can flag truncation
    // without a second COUNT query.  LIMIT cap+1 keeps the SQL planner
    // honest on huge intersections.
    sqlParams.push(cap + 1);
    const limitPlaceholder = `$${sqlParams.length}`;
    const sql = `
      WITH ${ctes.join(', ')}
      SELECT global_id
      FROM ${inputAlias}
      WHERE geom IS NOT NULL
      LIMIT ${limitPlaceholder}
    `;

    let rows: Array<{ global_id: string }>;
    try {
      rows = await this.prisma.$queryRawUnsafe<{ global_id: string }[]>(
        sql,
        ...sqlParams,
      );
    } catch (err) {
      // Surface SQL failures as 400s with a stable hint rather than
      // a 500 -- the caller's recipe + params are usually the cause,
      // not infrastructure.  The full SQL goes to the server log for
      // debugging; the response stays terse so it doesn't leak shape.
      this.logger.warn(
        `recipe-runner SQL failure for tool ${toolId}: ${(err as Error).message}`,
      );
      throw new BadRequestException(
        `Tool execution failed: ${(err as Error).message}`,
      );
    }

    const truncated = rows.length > cap;
    const featureIds = rows.slice(0, cap).map((r) => r.global_id);

    return {
      output: {
        kind: 'selection',
        layer: {
          itemId: targetSource.itemId,
          ...(targetSource.layerKey !== undefined
            ? { layerKey: targetSource.layerKey }
            : {}),
        },
        featureIds,
        truncated,
      },
    };
  }

  /**
   * OSM-features-overlay output path (#OSM).  Returns the OSM
   * features Overpass produces for a bbox derived from the
   * recipe's AOI parameter, plus the user's chosen presets +
   * tag filters.  v1 returns ALL features inside the bbox; finer
   * spatial filtering (distance, contains, etc.) lands in wave 2
   * when the spatial-filter generator gains a transient-scope
   * source kind that consumes the OSM scope.
   */
  private async runOsmOverlayInternal(
    recipe: RecipeAction,
    request: ToolRunRequest,
    user: AuthUser | null,
  ): Promise<ToolOsmOverlayResult> {
    if (recipe.output.kind !== 'osm-features-overlay') {
      throw new BadRequestException(
        `runOsmOverlayInternal called with the wrong output kind: ${recipe.output.kind}`,
      );
    }
    const resolved = resolveParameters(recipe.parameters, request.parameters);

    // #152 reverse-geocode-at-point: skip the osm-feature
    // parameter resolution entirely (the killer use case is "what
    // is here?" with no preset filter) and dispatch to the dedicated
    // resolveAtPoint path which uses Overpass is_in: + around:.
    if (recipe.reverseGeocodeAtPoint) {
      return this.runReverseGeocodeInternal(recipe, resolved, user);
    }

    if (!recipe.sourceParameterRef) {
      throw new BadRequestException(
        'osm-features-overlay output requires recipe.sourceParameterRef pointing at an osm-feature parameter',
      );
    }
    const sourceVal = resolved.get(recipe.sourceParameterRef);
    if (!sourceVal || sourceVal.kind !== 'osm-feature') {
      throw new BadRequestException(
        `Recipe sourceParameterRef '${recipe.sourceParameterRef}' must resolve to an osm-feature parameter`,
      );
    }

    // Two AOI shapes are supported for osm-features-overlay:
    //
    //   1. aoiParameterRef -> FeatureSourceParameter (drawn polygon,
    //      data_layer, derived_layer).  The classic "find things
    //      inside this area" flow.
    //   2. pointParameterRef -> PointParameter (#150).  The Nearest N
    //      flow: derive bbox from point +- radius, then post-fetch
    //      sort by distance to the point and (optionally) truncate
    //      to the top N closest.
    //
    // The two refs are alternatives; if both are set the point ref
    // wins because that's the more specific intent.
    let bbox: [number, number, number, number] | null = null;
    let centerPoint: { lng: number; lat: number } | null = null;
    // #151: when the AOI is an inline LineString / MultiLineString
    // we keep the geometry around so we can run a PostGIS ST_DWithin
    // post-pass against the actual line, dropping the corner over-
    // fetches the rectangular bbox path would otherwise return.
    let lineAoiGeom: GeoJsonGeometryLike | null = null;
    const distance = findDistanceParam(recipe.parameters, resolved);
    if (recipe.pointParameterRef) {
      const pointVal = resolved.get(recipe.pointParameterRef);
      if (!pointVal || pointVal.kind !== 'point') {
        throw new BadRequestException(
          `Recipe pointParameterRef '${recipe.pointParameterRef}' must resolve to a point parameter`,
        );
      }
      // The point itself doesn't require auth; it's just a lat/lng
      // pair the runtime sends.  Public tools with a point AOI work
      // for anonymous callers out of the box.
      centerPoint = { lng: pointVal.lng, lat: pointVal.lat };
      // Build a square bbox of (radius + small pad) around the
      // point.  The padDegrees-around-bbox path below is what the
      // FeatureSource AOI uses; we precompute the equivalent here.
      // A NumberParameter could supply the radius too, but the
      // recipe author is expected to wire a distance param for the
      // search radius -- mirrors how FIND_OSM_NEAR is shaped.
      if (!distance || distance <= 0) {
        throw new BadRequestException(
          'osm-features-overlay with pointParameterRef requires a distance parameter for the search radius',
        );
      }
      const radDegrees = distance / 111_000;
      bbox = [
        pointVal.lng - radDegrees,
        pointVal.lat - radDegrees,
        pointVal.lng + radDegrees,
        pointVal.lat + radDegrees,
      ];
    } else {
      if (!recipe.aoiParameterRef) {
        throw new BadRequestException(
          'osm-features-overlay output requires either recipe.aoiParameterRef or recipe.pointParameterRef',
        );
      }
      const aoiVal = resolved.get(recipe.aoiParameterRef);
      if (!aoiVal || aoiVal.kind !== 'feature-source') {
        throw new BadRequestException(
          `Recipe aoiParameterRef '${recipe.aoiParameterRef}' must resolve to a feature-source parameter`,
        );
      }
      // Anonymous callers can only use inline-geojson AOIs (drawn on
      // the map).  data_layer / derived_layer AOIs would read from a
      // portal layer whose ACL we can't satisfy without an auth user;
      // refuse the call rather than silently bypass the gate.
      if (!user && aoiVal.value.kind !== 'inline-geojson') {
        throw new UnauthorizedException(
          'This tool requires sign-in: layer-based AOIs are not available to anonymous viewers. Draw an area on the map instead.',
        );
      }
      bbox = await this.computeAoiBbox(aoiVal.value);
      if (!bbox) {
        throw new BadRequestException(
          `Could not compute a bbox from AOI parameter '${recipe.aoiParameterRef}'.  v1 only supports inline-geojson AOIs (drawn on the map).  Layer / selection AOIs land in wave 2.`,
        );
      }
      // #151: capture line geometries for the corridor post-pass.
      // Only inline-geojson lines qualify -- a layer-AOI line would
      // need ACL-gated geometry resolution; that's a wave-2 lift.
      if (aoiVal.value.kind === 'inline-geojson' && aoiVal.value.geojson) {
        const g = aoiVal.value.geojson as GeoJsonGeometryLike;
        if (g && (g.type === 'LineString' || g.type === 'MultiLineString')) {
          lineAoiGeom = g;
        }
      }
    }

    // Optional distance buffer: when the recipe declares a distance
    // parameter AND an AOI (not a point), pad the bbox by that
    // amount before the Overpass call so features just outside the
    // AOI but within distance are still returned.  Point-AOI tools
    // already baked the radius into the bbox above, so don't pad
    // again here.
    const padDegrees =
      !centerPoint && distance ? distance / 111_000 : 0;
    const paddedBbox: [number, number, number, number] = [
      bbox[0] - padDegrees,
      bbox[1] - padDegrees,
      bbox[2] + padDegrees,
      bbox[3] + padDegrees,
    ];

    // #101: per-recipe TTL override. Clamped to a sane range so a
    // typo in the recipe (e.g. 999999) can't permanently pin a stale
    // scope. 0 means "always fresh" (skip the cache); we map that to
    // ttlMs=0 which the resolver treats as "never cache hit, always
    // refetch + overwrite the cache row with a fresh expiresAt".
    let ttlMs: number | undefined;
    if (typeof sourceVal.ttlMinutes === 'number' && Number.isFinite(sourceVal.ttlMinutes)) {
      const minutes = Math.max(0, Math.min(7 * 24 * 60, sourceVal.ttlMinutes));
      ttlMs = minutes * 60 * 1000;
    }

    const result = await this.osm.resolve({
      presetIds: sourceVal.presetIds,
      ...(sourceVal.tagFilters && sourceVal.tagFilters.length > 0
        ? { tagFilters: sourceVal.tagFilters }
        : {}),
      bbox: paddedBbox,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      // #103: per-org Overpass endpoint lookup happens inside
      // OsmService when orgId is supplied. The user is the running
      // principal so their org is the one whose setting wins.
      ...(user?.orgId ? { orgId: user.orgId } : {}),
    });

    // Resolve human labels for the preset ids that were actually
    // queried so the client can title the result layer with the OSM
    // category the user picked instead of the generic tool name.
    // Lookups against an unknown id (theoretically possible if the
    // catalog drifts mid-deploy) skip silently so a single bad id
    // doesn't poison the title.
    const presetLabels: string[] = [];
    for (const id of sourceVal.presetIds) {
      try {
        const preset = await getOsmPreset(id);
        if (preset?.label) presetLabels.push(preset.label);
      } catch {
        /* unknown preset id; skip */
      }
    }

    // #151 Corridor tight-filter: when the AOI is a LineString /
    // MultiLineString, post-fetch ST_DWithin against the actual
    // line geometry to drop the corner over-fetches the rectangular
    // bbox path would otherwise return.  Skipped when no distance
    // param is configured (degenerate corridor with zero width).
    let features = result.features;
    if (lineAoiGeom && distance && distance > 0) {
      features = await this.filterByCorridor(
        features,
        lineAoiGeom,
        distance,
      );
    }

    // #150 Nearest N: when the recipe carries a pointParameterRef,
    // post-process the Overpass result so the client gets features
    // sorted by distance to the center point with a
    // `distance_meters` property attached.  An optional
    // `nearestLimitParameterRef` then truncates to the top N
    // closest -- without it every feature in the search radius
    // comes back (still sorted) which is useful for "list every
    // park within 0.5 mi" but not for "give me the 10 closest."
    if (centerPoint) {
      const annotated = features.map((f) => {
        const meters = approxDistanceMeters(centerPoint!, f.geometry);
        const props = { ...(f.properties ?? {}), distance_meters: meters };
        return { feature: f, meters, props };
      });
      annotated.sort((a, b) => a.meters - b.meters);
      let n = annotated.length;
      if (recipe.nearestLimitParameterRef) {
        const limitVal = resolved.get(recipe.nearestLimitParameterRef);
        if (limitVal && limitVal.kind === 'number') {
          const clamped = Math.max(1, Math.min(500, Math.floor(limitVal.value)));
          if (Number.isFinite(clamped)) n = Math.min(n, clamped);
        }
      }
      features = annotated.slice(0, n).map((a) => ({
        ...a.feature,
        properties: a.props,
      }));
    }

    return {
      output: {
        kind: 'osm-features-overlay',
        features,
        attribution: result.attribution,
        featureCount: features.length,
        truncated: false, // wave 2 surface when Overpass actually hit the cap
        presetLabels,
      },
    };
  }

  /**
   * Reverse-geocode-at-point internal (#152).  Resolves the point
   * parameter, calls OsmService.resolveAtPoint which runs the
   * Overpass `is_in: + around:` query, and returns the result
   * under the standard osm-features-overlay output shape so the
   * client renders it through the existing OSM layer-push path.
   *
   * The result is RANKED client-side (smallest polygon area first
   * so the building outranks the city outranks the state); we
   * just sort by feature.geometry size here as a server-side
   * default that the client can override.  Features without a
   * polygon stay at the end.
   */
  private async runReverseGeocodeInternal(
    recipe: RecipeAction,
    resolved: Map<string, ResolvedValue>,
    user: AuthUser | null,
  ): Promise<ToolOsmOverlayResult> {
    if (!recipe.pointParameterRef) {
      throw new BadRequestException(
        'reverseGeocodeAtPoint requires recipe.pointParameterRef pointing at a point parameter',
      );
    }
    const pointVal = resolved.get(recipe.pointParameterRef);
    if (!pointVal || pointVal.kind !== 'point') {
      throw new BadRequestException(
        `Recipe pointParameterRef '${recipe.pointParameterRef}' must resolve to a point parameter`,
      );
    }
    // Optional distance parameter sets the around-radius; defaults
    // to 50m which is roughly "the building you clicked, the
    // adjacent road, the immediately-adjacent POIs."
    const distance = findDistanceParam(recipe.parameters, resolved);
    const radius = distance && distance > 0 ? distance : 50;

    const result = await this.osm.resolveAtPoint({
      lng: pointVal.lng,
      lat: pointVal.lat,
      radiusMeters: radius,
      ...(user?.orgId ? { orgId: user.orgId } : {}),
    });

    // Server-side rough rank: smaller geometries (buildings,
    // points, short ways) before larger (admin polygons that
    // contain the point).  Uses approximate area via the
    // longitude*latitude span of the geometry's coordinates.
    const ranked = result.features
      .map((f) => ({ f, area: approxFeatureArea(f.geometry) }))
      .sort((a, b) => a.area - b.area)
      .map((x) => x.f);

    return {
      output: {
        kind: 'osm-features-overlay',
        features: ranked,
        attribution: result.attribution,
        featureCount: ranked.length,
        truncated: false,
        presetLabels: [],
      },
    };
  }

  /**
   * Relational-query output path (#142).  Runs the entire join in
   * a single Overpass round-trip using `around:<set>:<distance>`
   * chained predicates: Overpass's spatial index handles the
   * anchor-to-condition proximity natively, much cheaper than
   * fetching each preset separately and joining via PostGIS
   * ST_DWithin.  PostGIS is still used downstream for the
   * ST_Buffer visualization rings (Overpass doesn't generate
   * buffer polygons).
   *
   * v1 is AND-only across conditions; the schema reserves
   * `combinator` for OR support later.  The reference patterns
   * for this Overpass shape live in ldodds/osm-queries/tutorial
   * (around-with-set, radius-search).
   */
  private async runOsmRelationalInternal(
    action: OsmRelationalQueryAction,
    request: ToolRunRequest,
    user: AuthUser | null,
  ): Promise<ToolOsmRelationalResult> {
    if (!action.anchorPreset) {
      throw new BadRequestException(
        'osm-relational-query requires anchorPreset (the iD preset id of the features to find)',
      );
    }
    if (!action.conditions || action.conditions.length === 0) {
      throw new BadRequestException(
        'osm-relational-query requires at least one condition; for a single-preset query use a recipe with osm-features-overlay output instead',
      );
    }
    if (!action.aoiParameterRef) {
      throw new BadRequestException(
        'osm-relational-query requires aoiParameterRef pointing at a feature-source parameter for the search area',
      );
    }

    const resolved = resolveParameters(action.parameters, request.parameters);
    const aoiVal = resolved.get(action.aoiParameterRef);
    if (!aoiVal || aoiVal.kind !== 'feature-source') {
      throw new BadRequestException(
        `Relational aoiParameterRef '${action.aoiParameterRef}' must resolve to a feature-source parameter`,
      );
    }
    if (!user && aoiVal.value.kind !== 'inline-geojson') {
      throw new UnauthorizedException(
        'This tool requires sign-in: layer-based AOIs are not available to anonymous viewers. Draw an area on the map instead.',
      );
    }
    const bbox = await this.computeAoiBbox(aoiVal.value);
    if (!bbox) {
      throw new BadRequestException(
        `Could not compute a bbox from AOI parameter '${action.aoiParameterRef}'.  v1 supports inline-geojson AOIs (drawn on the map) and layer / selection AOIs.`,
      );
    }

    // Pad the bbox by the largest condition distance so anchors near
    // the AOI edge can still pick up matches that sit just outside
    // the polygon.  Cheap meters->degrees conversion (1deg ~ 111km)
    // over-pads at high latitudes; acceptable for the "schools near
    // parks within my city" use case where the latitude band is
    // small relative to the search radius.
    const conditionDistancesMeters = action.conditions.map((c) =>
      relationalDistanceToMeters(c.distance),
    );
    const maxDistanceMeters = Math.max(...conditionDistancesMeters);
    const padDegrees = maxDistanceMeters / 111_000;
    const paddedBbox: [number, number, number, number] = [
      bbox[0] - padDegrees,
      bbox[1] - padDegrees,
      bbox[2] + padDegrees,
      bbox[3] + padDegrees,
    ];

    // Per-recipe TTL clamp, same semantics as osm-features-overlay.
    let ttlMs: number | undefined;
    if (
      typeof action.ttlMinutes === 'number' &&
      Number.isFinite(action.ttlMinutes)
    ) {
      const minutes = Math.max(0, Math.min(7 * 24 * 60, action.ttlMinutes));
      ttlMs = minutes * 60 * 1000;
    }

    // Run the entire join in one Overpass round-trip via the
    // resolveRelational path.  Overpass's spatial index does the
    // anchor-to-condition distance check natively (including
    // any negation set-differences); we get back the surviving
    // anchors + supporting features already bucketed by which
    // preset they match.
    const negationDistancesMeters = (action.negations ?? []).map((n) =>
      relationalDistanceToMeters(n.distance),
    );
    let result;
    try {
      result = await this.osm.resolveRelational({
        anchorPresetId: action.anchorPreset,
        conditions: action.conditions.map((c, i) => ({
          presetId: c.preset,
          distanceMeters: conditionDistancesMeters[i]!,
          ...(c.tagFilters && c.tagFilters.length > 0
            ? { tagFilters: c.tagFilters }
            : {}),
        })),
        ...(action.negations && action.negations.length > 0
          ? {
              negations: action.negations.map((n, i) => ({
                presetId: n.preset,
                distanceMeters: negationDistancesMeters[i]!,
              })),
            }
          : {}),
        bbox: paddedBbox,
        ...(user?.orgId ? { orgId: user.orgId } : {}),
        ...(action.anchorMaxResults
          ? { maxFeatures: action.anchorMaxResults }
          : {}),
      });
    } catch (err) {
      // Relational queries over large bboxes with multiple
      // conditions blow past Overpass's 30 s server timeout
      // routinely. The default uncaught path bubbles to a 500
      // which reads as "the server broke," but the real meaning
      // is "your AOI + filters are too expensive to run in 30 s."
      // Re-throw as a BadRequestException with a clear,
      // action-oriented message the dialog can surface as-is.
      const msg = err instanceof Error ? err.message : String(err);
      // Overpass surfaces "too expensive" failures three ways:
      //   1. Quietly timing out at 30 s (timeout / 504 / cancelled).
      //   2. Returning HTTP 429 when our IP has hit the per-mirror
      //      query rate / quota limit.
      //   3. Returning HTTP 400 with an XHTML "request rejected"
      //      page when the QL planner blows its memory ceiling
      //      (multiple distance conditions + a wide AOI is the
      //      canonical trigger).
      // All three read to the user as "your query is too big for
      // Overpass to finish in one go." Re-raise as a 400 with one
      // unified, action-oriented message instead of a 500.
      const looksOverloaded =
        /timed out|timeout|too many requests|429|504|Overpass rejected|rejected the query/i.test(
          msg,
        );
      if (looksOverloaded) {
        throw new BadRequestException(
          'The OSM query was too large or complex for Overpass to finish. Try a smaller area of interest, fewer "Must NOT be near" rules, tighter distances, or run the query in pieces.',
        );
      }
      throw err;
    }
    // TTL override is plumbed for parity with the per-preset
    // resolve(), but relational queries don't currently consult
    // the cache.  Drop the variable so lint doesn't flag it.
    void ttlMs;

    // Bearing post-pass (#153).  For each declared bearing
    // predicate, walk the surviving anchors and keep only those
    // that have AT LEAST ONE supporting feature in the indicated
    // condition lying inside the angular arc from the supporting
    // feature TO the anchor.  Compass bearings: 0=N, 90=E,
    // 180=S, 270=W.  Tolerance widens the arc on either side.
    let survivingAnchorFeatures = result.anchor.features;
    if (action.bearings && action.bearings.length > 0) {
      for (const bp of action.bearings) {
        const cond = result.conditions[bp.conditionIndex];
        if (!cond) continue;
        const tolerance = Math.max(0, Math.min(180, bp.toleranceDegrees));
        const wanted = ((bp.bearingDegrees % 360) + 360) % 360;
        survivingAnchorFeatures = survivingAnchorFeatures.filter(
          (anchor) => {
            const ac = firstCoord(anchor.geometry);
            if (!ac) return false;
            for (const support of cond.supporting) {
              const sc = firstCoord(support.geometry);
              if (!sc) continue;
              const b = bearingDegrees(
                { lng: sc[0], lat: sc[1] },
                { lng: ac[0], lat: ac[1] },
              );
              const delta = Math.abs(((b - wanted + 540) % 360) - 180);
              if (delta <= tolerance) return true;
            }
            return false;
          },
        );
      }
    }

    // Buffers around each surviving anchor at the max condition
    // distance.  Server-side ST_Buffer over geography produces a
    // proper great-circle buffer; cast back to geometry for the
    // GeoJSON output.  Overpass doesn't generate buffer polygons,
    // so this PostGIS pass stays as the visualization layer.
    const buffers =
      survivingAnchorFeatures.length > 0
        ? await this.buildAnchorBuffers(
            survivingAnchorFeatures,
            maxDistanceMeters,
          )
        : [];

    // Each condition's candidateCount on the client is the
    // supportingCount from the resolver -- the number of
    // condition features that actually contributed to a survivor.
    return {
      output: {
        kind: 'osm-relational-result',
        anchor: {
          preset: result.anchor.presetId,
          presetLabel: result.anchor.presetLabel,
          features: survivingAnchorFeatures,
          candidateCount: survivingAnchorFeatures.length,
        },
        conditions: result.conditions.map((c) => ({
          preset: c.presetId,
          presetLabel: c.presetLabel,
          distanceMeters: c.distanceMeters,
          candidateCount: c.supportingCount,
          supporting: c.supporting,
        })),
        supporting: result.supporting,
        buffers,
        bearings: action.bearings ?? [],
        attribution: result.attribution,
        truncated: false,
      },
    };
  }

  /**
   * #151 corridor tight-filter.  Takes the OSM features returned
   * by Overpass (which only saw the line's rectangular bbox + a
   * pad) and drops those that lie outside the strict line buffer.
   * Single PostGIS query: ST_DWithin on geography casts so the
   * threshold is true-meters regardless of latitude or feature
   * geometry type (point / line / polygon).  Preserves input
   * order; returns the subset that survives.
   */
  private async filterByCorridor(
    features: OsmGeoJsonFeature[],
    lineGeom: GeoJsonGeometryLike,
    distanceMeters: number,
  ): Promise<OsmGeoJsonFeature[]> {
    if (features.length === 0) return features;
    const rows = await this.prisma.$queryRaw<
      Array<{ idx: number }>
    >`
      WITH features AS (
        SELECT
          (ord - 1)::int AS idx,
          ST_GeomFromGeoJSON((elem -> 'geometry')::text) AS geom
        FROM jsonb_array_elements(${JSON.stringify(features)}::jsonb)
          WITH ORDINALITY t(elem, ord)
      ),
      corridor AS (
        SELECT
          ST_GeomFromGeoJSON(${JSON.stringify(lineGeom)}::text) AS geom
      )
      SELECT f.idx
      FROM features f, corridor c
      WHERE ST_DWithin(f.geom::geography, c.geom::geography, ${distanceMeters})
      ORDER BY f.idx
    `;
    const keep = new Set(rows.map((r) => r.idx));
    return features.filter((_, i) => keep.has(i));
  }

  /**
   * Build the ST_Buffer polygons around each surviving anchor.
   * Geography buffer gives a true-distance ring on the sphere;
   * cast back to geometry for the GeoJSON output.  Properties on
   * each buffer feature carry the source anchor id and the radius
   * so client popups / labels can show "0.5 mi radius" without a
   * separate metadata fetch.
   */
  private async buildAnchorBuffers(
    anchors: OsmGeoJsonFeature[],
    radiusMeters: number,
  ): Promise<OsmGeoJsonFeature[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{ anchor_idx: number; anchor_id: string | null; buffer_geojson: string }>
    >`
      SELECT
        (ord - 1)::int AS anchor_idx,
        (elem ->> 'id') AS anchor_id,
        ST_AsGeoJSON(
          ST_Buffer(
            ST_GeomFromGeoJSON((elem -> 'geometry')::text)::geography,
            ${radiusMeters}
          )::geometry
        ) AS buffer_geojson
      FROM jsonb_array_elements(${JSON.stringify(anchors)}::jsonb)
        WITH ORDINALITY t(elem, ord)
    `;
    const buffers: OsmGeoJsonFeature[] = [];
    for (const row of rows) {
      try {
        const geometry = JSON.parse(row.buffer_geojson) as OsmGeoJsonFeature['geometry'];
        buffers.push({
          type: 'Feature',
          id: `buffer:${row.anchor_id ?? row.anchor_idx}`,
          properties: {
            anchorId: row.anchor_id,
            radiusMeters,
          },
          geometry,
        });
      } catch {
        // Skip rows where ST_Buffer produced something we can't
        // round-trip (would only happen on degenerate input
        // geometry; the anchor still ships, just without its
        // buffer ring).
      }
    }
    return buffers;
  }

  /**
   * Compute the bounding box of an AOI feature-source value.
   *
   * Inline GeoJSON (drawn polygons / rectangles) is computed in
   * memory. Layer / selection AOIs reach into the observation log
   * via PostGIS's ST_Extent and the per-layer scope produced by
   * dataLayerScope. featureIds (when supplied) narrow the extent to
   * the selected subset; an empty / absent list covers the whole
   * layer.
   *
   * Returns null only when the source isn't usable (no item id, no
   * geometry, layer empty), so callers can surface a sensible "your
   * AOI is empty" error instead of a silent zero-area query.
   */
  private async computeAoiBbox(
    value: FeatureSourceValue,
  ): Promise<[number, number, number, number] | null> {
    if (value.kind === 'inline-geojson' && value.geojson) {
      return bboxOfGeoJson(value.geojson);
    }
    if (
      (value.kind === 'data_layer' || value.kind === 'derived_layer') &&
      value.itemId &&
      value.layerKey
    ) {
      const scope = dataLayerScope(value.itemId, value.layerKey);
      // Read the latest-truth bbox over the observation log: a row
      // is "current" when its entity has no later observation, the
      // observation is a create / update (not a delete), and its
      // valid_from / valid_to window covers now. DISTINCT ON keeps
      // one row per entity. ST_Extent returns a box2d we then split
      // into the lat/lng pair the OSM resolver expects.
      const ids =
        value.featureIds && value.featureIds.length > 0
          ? value.featureIds.map((id) => String(id))
          : null;
      type ExtentRow = { extent: string | null };
      const rows: ExtentRow[] = ids
        ? await this.prisma.$queryRaw<ExtentRow[]>(
            // Use ANY(... uuid[]) so a featureIds array of 100k
            // still binds in a single param; IN (...) would be
            // node-by-node-bound.
            Prisma.sql`
              SELECT ST_Extent(latest.geom)::text AS extent
              FROM (
                SELECT DISTINCT ON (entity) entity, geom, kind
                FROM observation
                WHERE scope = ${scope}
                  AND valid_from <= now()
                  AND (valid_to IS NULL OR valid_to > now())
                  AND entity = ANY(${ids}::uuid[])
                ORDER BY entity, valid_from DESC, tx_time DESC
              ) latest
              WHERE latest.kind != 'delete' AND latest.geom IS NOT NULL
            `,
          )
        : await this.prisma.$queryRaw<ExtentRow[]>(
            Prisma.sql`
              SELECT ST_Extent(latest.geom)::text AS extent
              FROM (
                SELECT DISTINCT ON (entity) entity, geom, kind
                FROM observation
                WHERE scope = ${scope}
                  AND valid_from <= now()
                  AND (valid_to IS NULL OR valid_to > now())
                ORDER BY entity, valid_from DESC, tx_time DESC
              ) latest
              WHERE latest.kind != 'delete' AND latest.geom IS NOT NULL
            `,
          );
      const extent = rows[0]?.extent;
      if (!extent) return null;
      // PostGIS returns the BOX(2D) literal as "BOX(minx miny,maxx maxy)".
      // Parse with a non-capturing-friendly regex; values are
      // floating-point with optional minus signs.
      const m = extent.match(
        /BOX\((-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)\)/,
      );
      if (!m) return null;
      const minX = Number(m[1]);
      const minY = Number(m[2]);
      const maxX = Number(m[3]);
      const maxY = Number(m[4]);
      if (![minX, minY, maxX, maxY].every((v) => Number.isFinite(v))) {
        return null;
      }
      return [minX, minY, maxX, maxY];
    }
    return null;
  }
}

// ----------------------------------------------------------------------
// Parameter resolution + step substitution.  Pure functions split out
// so the test suite can exercise them without a Prisma instance.
// ----------------------------------------------------------------------

/**
 * Resolve every parameter declared on the recipe against the
 * request's parameter map.  Required parameters that don't have a
 * value (and no binding default) raise a BadRequestException.
 * Optional parameters that aren't supplied resolve to whatever the
 * binding's default is, or are skipped entirely.
 */
export function resolveParameters(
  declarations: ToolParameter[],
  supplied: Record<string, ToolRunInput>,
): Map<string, ResolvedValue> {
  const resolved = new Map<string, ResolvedValue>();
  for (const param of declarations) {
    const provided = supplied[param.name];
    const value = resolveOne(param, provided);
    if (value !== undefined) {
      resolved.set(param.name, value);
    } else if (param.required) {
      throw new BadRequestException(
        `Required parameter '${param.name}' is missing`,
      );
    }
  }
  return resolved;
}

function resolveOne(
  param: ToolParameter,
  provided: ToolRunInput | undefined,
): ResolvedValue | undefined {
  switch (param.kind) {
    case 'feature-source':
      return resolveFeatureSource(param, provided);
    case 'predicate':
      return resolvePredicateParam(param, provided);
    case 'distance':
      return resolveDistanceParam(param, provided);
    case 'number':
      return resolveNumberParam(param, provided);
    case 'text':
      return resolveTextParam(param, provided);
    case 'osm-feature':
      return resolveOsmFeatureParam(param, provided);
    case 'point':
      return resolvePointParam(param, provided);
  }
}

/**
 * Resolve a `point` runtime parameter into a normalised
 * `{ kind: 'point'; lng, lat }` ResolvedValue.  Accepts the
 * wire shape `{ kind: 'point-input', lng: number, lat: number }`
 * from the runtime panel, or falls back to the parameter's
 * hardcoded / default coordinates.  Returns undefined when the
 * parameter is required-but-unsupplied so the caller can throw
 * a consistent error.
 */
function resolvePointParam(
  param: Extract<ToolParameter, { kind: 'point' }>,
  provided: ToolRunInput | undefined,
): ResolvedValue | undefined {
  if (param.binding.mode === 'hardcoded') {
    return {
      kind: 'point',
      lng: param.binding.lng,
      lat: param.binding.lat,
    };
  }
  // runtime-pick: prefer caller-supplied coordinates; fall back to
  // the parameter's defaults if both are present (half-defaults
  // count as "no default" -- see PointParameter JSDoc).
  if (
    provided &&
    typeof provided === 'object' &&
    'kind' in provided &&
    (provided as { kind?: unknown }).kind === 'point-input'
  ) {
    const p = provided as unknown as {
      kind: 'point-input';
      lng?: unknown;
      lat?: unknown;
    };
    if (typeof p.lng === 'number' && typeof p.lat === 'number') {
      return { kind: 'point', lng: p.lng, lat: p.lat };
    }
  }
  if (
    typeof param.binding.defaultLng === 'number' &&
    typeof param.binding.defaultLat === 'number'
  ) {
    return {
      kind: 'point',
      lng: param.binding.defaultLng,
      lat: param.binding.defaultLat,
    };
  }
  return undefined;
}

function resolveOsmFeatureParam(
  param: Extract<ToolParameter, { kind: 'osm-feature' }>,
  provided: ToolRunInput | undefined,
): ResolvedValue | undefined {
  // Hardcoded binding: ignore whatever the client sent and use the
  // baked-in preset / filter set.  This is what a "Find pharmacies
  // near my facility" tool with no user discretion looks like.
  if (param.binding.mode === 'hardcoded') {
    return {
      kind: 'osm-feature',
      presetIds: param.binding.presetIds,
      ...(param.binding.tagFilters && param.binding.tagFilters.length > 0
        ? { tagFilters: param.binding.tagFilters }
        : {}),
      ...(typeof param.ttlMinutes === 'number'
        ? { ttlMinutes: param.ttlMinutes }
        : {}),
    };
  }
  // runtime-pick: client sent {kind:'osm-feature-input', presetIds, tagFilters}.
  // Fall back to defaults when omitted.
  if (
    provided !== undefined &&
    typeof provided === 'object' &&
    provided !== null &&
    'kind' in provided &&
    (provided as { kind?: string }).kind === 'osm-feature-input'
  ) {
    const input = provided as {
      kind: 'osm-feature-input';
      presetIds?: string[];
      tagFilters?: OsmTagFilter[];
    };
    if (!Array.isArray(input.presetIds) || input.presetIds.length === 0) {
      throw new BadRequestException(
        `Parameter '${param.name}': presetIds must be a non-empty array`,
      );
    }
    if (
      param.binding.allowedPresetIds &&
      param.binding.allowedPresetIds.length > 0
    ) {
      for (const id of input.presetIds) {
        if (!param.binding.allowedPresetIds.includes(id)) {
          throw new BadRequestException(
            `Parameter '${param.name}': preset '${id}' is not in the allowed list`,
          );
        }
      }
    }
    if (
      input.tagFilters &&
      input.tagFilters.length > 0 &&
      param.binding.allowCustomTagFilters === false
    ) {
      throw new BadRequestException(
        `Parameter '${param.name}' does not allow custom tag filters`,
      );
    }
    return {
      kind: 'osm-feature',
      presetIds: input.presetIds,
      ...(input.tagFilters && input.tagFilters.length > 0
        ? { tagFilters: input.tagFilters }
        : {}),
      // The recipe author's TTL setting wins over any runtime
      // ttlMinutes the client tried to set: the recipe is the
      // contract; clients can't override caching behavior just by
      // POSTing a different number. (If we wanted user-tunable
      // freshness we'd surface it as a separate parameter.)
      ...(typeof param.ttlMinutes === 'number'
        ? { ttlMinutes: param.ttlMinutes }
        : {}),
    };
  }
  // No input + runtime-pick: fall through to the binding defaults.
  if (
    param.binding.defaultPresetIds &&
    param.binding.defaultPresetIds.length > 0
  ) {
    return {
      kind: 'osm-feature',
      presetIds: param.binding.defaultPresetIds,
      ...(param.binding.defaultTagFilters &&
      param.binding.defaultTagFilters.length > 0
        ? { tagFilters: param.binding.defaultTagFilters }
        : {}),
      ...(typeof param.ttlMinutes === 'number'
        ? { ttlMinutes: param.ttlMinutes }
        : {}),
    };
  }
  return undefined;
}

function resolveFeatureSource(
  param: Extract<ToolParameter, { kind: 'feature-source' }>,
  provided: ToolRunInput | undefined,
): ResolvedValue | undefined {
  if (provided !== undefined && typeof provided === 'object' && provided !== null) {
    const v = provided as FeatureSourceValue;
    if (
      v.kind !== 'data_layer' &&
      v.kind !== 'derived_layer' &&
      v.kind !== 'inline-geojson'
    ) {
      throw new BadRequestException(
        `Parameter '${param.name}' must be a FeatureSourceValue with kind data_layer, derived_layer, or inline-geojson`,
      );
    }
    return { kind: 'feature-source', value: v };
  }
  // Fall back to binding-defined defaults.
  if (param.binding.mode === 'hardcoded') {
    return { kind: 'feature-source', value: param.binding.value };
  }
  if (
    param.binding.mode === 'runtime-host' &&
    param.binding.defaultValue !== undefined
  ) {
    return { kind: 'feature-source', value: param.binding.defaultValue };
  }
  return undefined;
}

function resolvePredicateParam(
  param: Extract<ToolParameter, { kind: 'predicate' }>,
  provided: ToolRunInput | undefined,
): ResolvedValue | undefined {
  if (typeof provided === 'string') {
    const value = provided as SpatialPredicate;
    if (
      param.binding.mode === 'runtime-pick' &&
      param.binding.allowed &&
      !param.binding.allowed.includes(value)
    ) {
      throw new BadRequestException(
        `Parameter '${param.name}' value '${value}' is not in the allowed set`,
      );
    }
    return { kind: 'predicate', value };
  }
  if (param.binding.mode === 'hardcoded') {
    return { kind: 'predicate', value: param.binding.value };
  }
  if (param.binding.mode === 'runtime-pick') {
    return { kind: 'predicate', value: param.binding.defaultValue };
  }
  return undefined;
}

function resolveDistanceParam(
  param: Extract<ToolParameter, { kind: 'distance' }>,
  provided: ToolRunInput | undefined,
): ResolvedValue | undefined {
  let meters: number | undefined;
  if (typeof provided === 'number') {
    meters = provided;
  } else if (param.binding.mode === 'hardcoded') {
    meters = param.binding.meters;
  } else if (param.binding.mode === 'runtime-input') {
    meters = param.binding.defaultMeters;
  }
  if (meters === undefined) return undefined;
  if (!Number.isFinite(meters) || meters <= 0) {
    throw new BadRequestException(
      `Parameter '${param.name}' must be a positive finite number of meters`,
    );
  }
  if (param.binding.mode === 'runtime-input') {
    const { minMeters, maxMeters } = param.binding;
    if (minMeters !== undefined && meters < minMeters) {
      throw new BadRequestException(
        `Parameter '${param.name}' must be at least ${minMeters} meters`,
      );
    }
    if (maxMeters !== undefined && meters > maxMeters) {
      throw new BadRequestException(
        `Parameter '${param.name}' must be at most ${maxMeters} meters`,
      );
    }
  }
  return { kind: 'distance', meters };
}

function resolveNumberParam(
  param: Extract<ToolParameter, { kind: 'number' }>,
  provided: ToolRunInput | undefined,
): ResolvedValue | undefined {
  let value: number | undefined;
  if (typeof provided === 'number') value = provided;
  else if (param.binding.mode === 'hardcoded') value = param.binding.value;
  else if (param.binding.mode === 'runtime-input')
    value = param.binding.defaultValue;
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) {
    throw new BadRequestException(
      `Parameter '${param.name}' must be a finite number`,
    );
  }
  if (param.binding.mode === 'runtime-input') {
    const { min, max } = param.binding;
    if (min !== undefined && value < min) {
      throw new BadRequestException(
        `Parameter '${param.name}' must be at least ${min}`,
      );
    }
    if (max !== undefined && value > max) {
      throw new BadRequestException(
        `Parameter '${param.name}' must be at most ${max}`,
      );
    }
  }
  return { kind: 'number', value };
}

function resolveTextParam(
  param: Extract<ToolParameter, { kind: 'text' }>,
  provided: ToolRunInput | undefined,
): ResolvedValue | undefined {
  if (typeof provided === 'string') {
    return { kind: 'text', value: provided };
  }
  if (param.binding.mode === 'hardcoded') {
    return { kind: 'text', value: param.binding.value };
  }
  if (
    param.binding.mode === 'runtime-input' &&
    typeof param.binding.defaultValue === 'string'
  ) {
    return { kind: 'text', value: param.binding.defaultValue };
  }
  return undefined;
}

/**
 * Walk a step's params and replace every `{ kind: 'parameter', name }`
 * reference with the resolved value.  Returns a new step with the
 * resolved-shape params; the generator's `validate` consumes it.
 *
 * The substitution is intentionally narrow: only spatial-filter
 * accepts parameter refs in v1, so we walk only its known fields.
 * If the union grows (e.g. parameterized distance on buffer), extend
 * here.  Doing this explicitly rather than via a deep walk avoids
 * accidentally substituting structural keys that happen to be named
 * `parameter` somewhere in a future step's params.
 */
export function substituteStep(
  step: ToolStep,
  resolved: Map<string, ResolvedValue>,
): ToolStep {
  if (step.tool === 'spatial-filter') {
    const p = step.params;
    return {
      tool: 'spatial-filter',
      params: {
        otherSource: substituteSourceRef(p.otherSource, resolved),
        predicate: substitutePredicateRef(p.predicate, resolved),
        ...(p.distance !== undefined
          ? { distance: substituteDistanceRef(p.distance, resolved) }
          : {}),
      },
    };
  }
  return step;
}

function substituteSourceRef(
  ref: SourceRef,
  resolved: Map<string, ResolvedValue>,
): SourceRef {
  if (ref.kind !== 'parameter') return ref;
  const value = resolved.get(ref.name);
  if (!value) {
    throw new BadRequestException(
      `spatial-filter references parameter '${ref.name}' but the parameter has no resolved value`,
    );
  }
  if (value.kind !== 'feature-source') {
    throw new BadRequestException(
      `spatial-filter.otherSource expected a feature-source parameter for '${ref.name}', got ${value.kind}`,
    );
  }
  const fs = value.value;
  if (fs.kind === 'inline-geojson') {
    if (fs.geojson === undefined) {
      throw new BadRequestException(
        `inline-geojson parameter '${ref.name}' has no geometry`,
      );
    }
    return { kind: 'inline-geometry', geometry: fs.geojson };
  }
  if (fs.kind === 'data_layer' || fs.kind === 'derived_layer') {
    if (!fs.itemId) {
      throw new BadRequestException(
        `feature-source parameter '${ref.name}' is missing an itemId`,
      );
    }
    // SpatialFilterStep's data_layer source only supports
    // data_layer; if the user wired a derived_layer here, fall
    // through to a clear error rather than silently misreading.
    if (fs.kind === 'derived_layer') {
      throw new BadRequestException(
        `spatial-filter.otherSource cannot point at a derived_layer yet; pick a data_layer`,
      );
    }
    return {
      kind: 'data_layer',
      itemId: fs.itemId,
      ...(fs.layerKey ? { layerKey: fs.layerKey } : {}),
      ...(fs.featureIds && fs.featureIds.length > 0
        ? { featureIds: fs.featureIds }
        : {}),
    };
  }
  throw new BadRequestException(
    `feature-source parameter '${ref.name}' has unsupported kind '${(fs as { kind?: string }).kind ?? 'unknown'}'`,
  );
}

function substitutePredicateRef(
  ref: PredicateRef,
  resolved: Map<string, ResolvedValue>,
): PredicateRef {
  if (ref.kind !== 'parameter') return ref;
  const value = resolved.get(ref.name);
  if (!value) {
    throw new BadRequestException(
      `spatial-filter references predicate parameter '${ref.name}' but it has no resolved value`,
    );
  }
  if (value.kind !== 'predicate') {
    throw new BadRequestException(
      `spatial-filter.predicate expected a predicate parameter for '${ref.name}', got ${value.kind}`,
    );
  }
  return { kind: 'fixed', value: value.value };
}

function substituteDistanceRef(
  ref: DistanceRef,
  resolved: Map<string, ResolvedValue>,
): DistanceRef {
  if (ref.kind !== 'parameter') return ref;
  const value = resolved.get(ref.name);
  if (!value) {
    throw new BadRequestException(
      `spatial-filter references distance parameter '${ref.name}' but it has no resolved value`,
    );
  }
  if (value.kind !== 'distance') {
    throw new BadRequestException(
      `spatial-filter.distance expected a distance parameter for '${ref.name}', got ${value.kind}`,
    );
  }
  return { kind: 'fixed', meters: value.meters };
}

/**
 * Find the first distance parameter the recipe declares and look
 * up its resolved meters value.  Used by the osm-overlay runner to
 * pad the AOI bbox so features just outside the AOI are still in
 * scope.  Returns null when the recipe has no distance parameter,
 * or has one that didn't resolve (optional + no default + no
 * input).
 */
function findDistanceParam(
  declarations: ToolParameter[],
  resolved: Map<string, ResolvedValue>,
): number | null {
  for (const p of declarations) {
    if (p.kind !== 'distance') continue;
    const v = resolved.get(p.name);
    if (v && v.kind === 'distance') return v.meters;
  }
  return null;
}

/**
 * Compute the axis-aligned bbox of a GeoJSON value.  Accepts a
 * bare Geometry, a Feature, or a FeatureCollection.  Returns null
 * when the shape has no coordinates (e.g. an empty
 * GeometryCollection).
 */
function bboxOfGeoJson(
  geojson: unknown,
): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (coord: unknown): void => {
    if (Array.isArray(coord)) {
      if (typeof coord[0] === 'number' && typeof coord[1] === 'number') {
        if (coord[0] < minX) minX = coord[0];
        if (coord[1] < minY) minY = coord[1];
        if (coord[0] > maxX) maxX = coord[0];
        if (coord[1] > maxY) maxY = coord[1];
      } else {
        for (const c of coord) visit(c);
      }
    }
  };
  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (n.type === 'FeatureCollection' && Array.isArray(n.features)) {
      for (const f of n.features) walk(f);
      return;
    }
    if (n.type === 'Feature') {
      walk(n.geometry);
      return;
    }
    if (Array.isArray(n.coordinates)) {
      visit(n.coordinates);
    }
  }
  walk(geojson);
  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return null;
  }
  return [minX, minY, maxX, maxY];
}

/**
 * Approximate great-circle distance in meters from a (lng, lat)
 * center to a GeoJSON geometry's representative coordinate
 * (#150).  Uses the haversine formula on a sphere with mean
 * Earth radius.  Geometry-aware in the simplest way: for Point
 * uses the point; for Line / Polygon types takes the first
 * coordinate ring's first vertex.  Accuracy is fine for the
 * "sort by distance" use case at sub-100m feature sizes against
 * search radii of hundreds of meters or more; if we ever need
 * proper edge distance for big polygons we move this to PostGIS
 * `ST_Distance(geography)`.
 */
function approxDistanceMeters(
  center: { lng: number; lat: number },
  geom: unknown,
): number {
  const coord = firstCoord(geom);
  if (!coord) return Infinity;
  const [lng2, lat2] = coord;
  const R = 6371000; // mean Earth radius in meters
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - center.lat);
  const dLng = toRad(lng2 - center.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(center.lat)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Crude bbox-area proxy for ranking GeoJSON geometries (#152).
 * Walks the coordinate tree, tracks min/max lng/lat, returns
 * (max_lng - min_lng) * (max_lat - min_lat) in degrees-squared.
 * Not a real spherical area; just enough resolution to order
 * "the building polygon at this point" before "the city polygon
 * containing it" before "the state polygon containing that."
 * Points get 0 so they always sort first.
 */
function approxFeatureArea(geom: unknown): number {
  if (!geom || typeof geom !== 'object') return Number.POSITIVE_INFINITY;
  const g = geom as { type?: string; coordinates?: unknown };
  if (g.type === 'Point') return 0;
  if (!Array.isArray(g.coordinates)) return Number.POSITIVE_INFINITY;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const stack: unknown[] = [g.coordinates];
  while (stack.length > 0) {
    const n = stack.pop();
    if (!Array.isArray(n)) continue;
    if (
      n.length >= 2 &&
      typeof n[0] === 'number' &&
      typeof n[1] === 'number'
    ) {
      const x = n[0] as number;
      const y = n[1] as number;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      continue;
    }
    for (const c of n) stack.push(c);
  }
  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return Number.POSITIVE_INFINITY;
  }
  return (maxX - minX) * (maxY - minY);
}

/**
 * Compass bearing (#153) in degrees [0, 360) FROM `from` TO `to`,
 * measured clockwise from north.  Uses the standard spherical
 * great-circle formula -- accurate for any pair of WGS-84 lng/lat
 * points.  0=N, 90=E, 180=S, 270=W; that's the convention every
 * navigation tool ships.
 */
function bearingDegrees(
  from: { lng: number; lat: number },
  to: { lng: number; lat: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const phi1 = toRad(from.lat);
  const phi2 = toRad(to.lat);
  const dLng = toRad(to.lng - from.lng);
  const y = Math.sin(dLng) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng);
  const theta = Math.atan2(y, x);
  return (toDeg(theta) + 360) % 360;
}

/**
 * First coordinate pair from any GeoJSON geometry shape.  Walks
 * nested coordinate arrays until it finds the deepest leaf pair.
 * Returns null for malformed input.
 */
function firstCoord(geom: unknown): [number, number] | null {
  if (!geom || typeof geom !== 'object') return null;
  const g = geom as { type?: string; coordinates?: unknown };
  if (!Array.isArray(g.coordinates)) return null;
  let cur: unknown = g.coordinates;
  // Drill into the first element until we hit a leaf [lng, lat].
  for (let depth = 0; depth < 6; depth++) {
    if (!Array.isArray(cur)) return null;
    if (
      cur.length >= 2 &&
      typeof cur[0] === 'number' &&
      typeof cur[1] === 'number'
    ) {
      return [cur[0] as number, cur[1] as number];
    }
    cur = cur[0];
  }
  return null;
}

/**
 * Convert a RelationalDistance (value + unit) into meters for the
 * PostGIS geography-based proximity check.  Unknown units default
 * to meters so a malformed action payload degrades to a sane
 * search radius rather than throwing.
 */
function relationalDistanceToMeters(distance: RelationalDistance): number {
  const v = Number(distance.value);
  if (!Number.isFinite(v) || v <= 0) return 0;
  switch (distance.unit) {
    case 'm':
      return v;
    case 'km':
      return v * 1000;
    case 'ft':
      return v * 0.3048;
    case 'mi':
      return v * 1609.344;
    default:
      return v;
  }
}

/**
 * #157 Phase 1: if the action carries a workflow graph, convert
 * the graph to a topologically-ordered pipeline and return a new
 * action with `pipeline` populated from that order. When no graph
 * is present, the action is returned unchanged.
 *
 * Phase 1 ships single-input nodes only, so a topo sort always
 * yields a valid linear sequence. Cycles, missing nodes, and
 * duplicate ids surface as a BadRequestException so the author
 * fixes their graph rather than getting a silent partial run.
 *
 * The `graph` field is stripped from the returned action so the
 * downstream runners (which only know about `pipeline`) don't
 * see a stale reference.
 */
function linearizeIfGraph(
  action: RecipeAction,
  toolId: string,
): RecipeAction {
  if (!action.graph) return action;
  const graph: WorkflowGraph = action.graph;
  const sorted = topologicalSort(graph);
  if (sorted.error || !sorted.order) {
    throw new BadRequestException(
      `Tool ${toolId} has an invalid workflow graph: ` +
        (sorted.detail ?? sorted.error ?? 'unknown error'),
    );
  }
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const pipeline: ToolStep[] = sorted.order.map((id) => byId.get(id)!.step);
  const { graph: _omitted, ...rest } = action;
  return { ...rest, pipeline };
}

