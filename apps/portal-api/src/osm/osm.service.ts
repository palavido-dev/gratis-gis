// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';

import { EngineService } from '../engine/engine.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { OverpassClient } from './overpass-client.js';
import {
  buildOverpassQl,
  buildRelationalOverpassQl,
  buildReverseGeocodeOverpassQl,
} from './overpass-ql.js';
import {
  osmToGeoJson,
  type OsmGeoJsonFeature,
  type OsmGeoJsonGeometry,
} from './osm-to-geojson.js';
import { getOsmPresets, type OsmPreset } from './preset-catalog.js';

/**
 * Resolved input shape for one OSM source resolution.  Mirrors the
 * `osm-query` SourceRef variant in shared-types post-substitution,
 * plus the AOI-derived bbox the recipe runner computes.
 */
export interface OsmSourceResolveInput {
  presetIds: string[];
  tagFilters?: Array<{ key: string; value: string; op?: 'equals' | 'contains' | 'regex' }>;
  bbox: [number, number, number, number];
  /** Override endpoint; falls back to the org setting, then env, then default. */
  endpoint?: string;
  /**
   * #103: org context. When set and `endpoint` is not, OsmService
   * looks up the organisation row and uses its
   * `osmOverpassEndpoint` field (if non-null) before falling back
   * to the env-var. Lets a self-hosted org point at its own
   * Overpass without rebuilding the image.
   */
  orgId?: string;
  /** Override TTL (ms); falls back to 1h. */
  ttlMs?: number;
  /** Override max features; falls back to 50000. */
  maxFeatures?: number;
}

/**
 * Input shape for the reverse-geocode resolver (#152).  Point +
 * radius; no preset filter (we want everything at the point).
 * The runtime caller ranks results client-side.
 */
export interface OsmReverseGeocodeInput {
  lng: number;
  lat: number;
  /** Search radius in meters for the `around:` predicate.  v1
   *  defaults to 50m when not supplied by the recipe -- big enough
   *  to grab the adjacent building / road, small enough to keep
   *  the Overpass payload tight. */
  radiusMeters?: number;
  endpoint?: string;
  orgId?: string;
  maxFeatures?: number;
}

export interface OsmReverseGeocodeResult {
  features: OsmGeoJsonFeature[];
  attribution: string;
  featureCount: number;
}

/**
 * Input shape for the relational query resolver (#142).  Anchor +
 * conditions + AOI bbox.  No tag-filter knob in v1: relational
 * tools are "school near park," not "school near park named X."
 */
export interface OsmRelationalResolveInput {
  anchorPresetId: string;
  conditions: Array<{
    presetId: string;
    distanceMeters: number;
    /** Per-condition tag filters (e.g. `name~"Lincoln"`).  Passed
     *  through to the Overpass QL builder; same shape and ops
     *  the OsmFeatureParameter tag filters use. */
    tagFilters?: Array<{
      key: string;
      value: string;
      op?: 'equals' | 'contains' | 'regex';
    }>;
  }>;
  /**
   * Negation conditions (#153): drop anchors that have ANY feature
   * of a negation preset within the threshold.  Server-side via
   * Overpass set-difference; no extra round-trips.
   */
  negations?: Array<{ presetId: string; distanceMeters: number }>;
  bbox: [number, number, number, number];
  endpoint?: string;
  orgId?: string;
  maxFeatures?: number;
}

export interface OsmRelationalResolveResult {
  anchor: {
    presetId: string;
    presetLabel: string;
    features: OsmGeoJsonFeature[];
  };
  conditions: Array<{
    presetId: string;
    presetLabel: string;
    distanceMeters: number;
    supportingCount: number;
    /** Per-condition supporting features.  Needed by the bearing
     *  post-pass (#153) to evaluate "anchor lies NW of THIS
     *  condition's supporting feature" without re-classifying
     *  the flat list.  Same features also appear in the flat
     *  `supporting` array (de-duped). */
    supporting: OsmGeoJsonFeature[];
  }>;
  supporting: OsmGeoJsonFeature[];
  attribution: string;
  featureCount: number;
}

export interface OsmResolveResult {
  /** observation-log scope key downstream SQL can read from. */
  scope: string;
  /** Number of features the resolver wrote (or matched in cache). */
  featureCount: number;
  /** True when a cache hit served the request; false on a fresh
   *  Overpass call.  Useful for telemetry. */
  cacheHit: boolean;
  /** The features in GeoJSON form, for callers that want them
   *  directly (e.g. the osm-features-overlay output sink that
   *  surfaces them on the host map without going through the SQL
   *  layer). */
  features: OsmGeoJsonFeature[];
  /** Attribution string suitable for surfacing in the UI.
   *  Required by ODbL whenever OSM-derived features are shown. */
  attribution: string;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h
const DEFAULT_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const ATTRIBUTION = '© OpenStreetMap contributors';

@Injectable()
export class OsmService {
  private readonly logger = new Logger(OsmService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: EngineService,
    private readonly client: OverpassClient,
  ) {}

  /**
   * Resolve an `osm-query` SourceRef into a populated observation
   * scope.  Returns either the cached scope (when fresh) or a
   * newly-materialised one (when the cache is cold or expired).
   *
   * The bbox is rounded to ~10m precision before hashing so a
   * recipe rerun with a fractionally-different AOI still hits the
   * same cache row.  Tag filters are normalised (sorted by key,
   * lowercased ops) so call-site key ordering doesn't fragment the
   * cache.
   */
  async resolve(input: OsmSourceResolveInput): Promise<OsmResolveResult> {
    if (!input.presetIds || input.presetIds.length === 0) {
      throw new Error('OsmService.resolve: presetIds must not be empty');
    }
    // #103: endpoint resolution order is explicit input override
    // -> per-org setting -> env-var -> hardcoded default. Each tier
    // is consulted only when the previous one is unset, so an org
    // running a private Overpass mirror gets it without breaking
    // recipes that pre-date the feature.
    let endpoint = input.endpoint;
    if (!endpoint && input.orgId) {
      try {
        const org = await this.prisma.organization.findUnique({
          where: { id: input.orgId },
          select: { osmOverpassEndpoint: true },
        });
        if (org?.osmOverpassEndpoint) {
          endpoint = org.osmOverpassEndpoint;
        }
      } catch (err) {
        // Org lookup failures should not block a resolution; the
        // upstream cron / health checks surface the org row issue
        // separately. Fall through to the env / default endpoint.
        this.logger.warn(
          `Per-org Overpass endpoint lookup failed for org ${input.orgId}: ${err instanceof Error ? err.message : String(err)}. Falling back to env / default.`,
        );
      }
    }
    endpoint = endpoint ?? process.env.GRATIS_GIS_OSM_OVERPASS_ENDPOINT ?? DEFAULT_ENDPOINT;
    const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
    const maxFeatures = input.maxFeatures ?? 50000;

    const hash = hashQuery(input, endpoint);

    // #101: a recipe author can request ttlMs=0 to mean "always
    // fresh" -- skip the cache hit entirely. The cache row itself
    // still gets upserted on miss so concurrent callers within the
    // same Overpass response window see a single materialisation.
    const cached = ttlMs > 0
      ? await this.prisma.osmQueryCache.findUnique({ where: { hash } })
      : null;
    if (cached && cached.expiresAt.getTime() > Date.now()) {
      // Fresh.  Skip Overpass; pull features out of the
      // observation log via the engine read path.
      const features = await this.readFeaturesFromScope(cached.scope);
      return {
        scope: cached.scope,
        featureCount: cached.featureCount,
        cacheHit: true,
        features,
        attribution: ATTRIBUTION,
      };
    }

    // Cache miss: hit Overpass.
    const presets = await getOsmPresets(input.presetIds);
    const ql = buildOverpassQl({
      presets,
      ...(input.tagFilters ? { tagFilters: input.tagFilters } : {}),
      bbox: input.bbox,
      maxFeatures,
    });
    this.logger.log(
      `OSM resolve (cache miss): presets=${input.presetIds.join(',')} bbox=${input.bbox.join(',')} -> Overpass`,
    );
    const response = await this.client.run({ endpoint, ql });
    const collection = osmToGeoJson(response);
    // Pre-slice count so callers can set truncated when Overpass (or
    // our soft cap) returned more than we keep. Cache stores the
    // persisted slice length; the return value keeps the raw count.
    const rawCount = collection.features.length;
    const features = collection.features.slice(0, maxFeatures);

    const scope = `osm:${hash}`;
    await this.writeFeaturesToScope(scope, features);

    // Persist (or refresh) the cache row.
    const expiresAt = new Date(Date.now() + ttlMs);
    await this.prisma.osmQueryCache.upsert({
      where: { hash },
      create: {
        hash,
        scope,
        presetIds: input.presetIds,
        ...(input.tagFilters && input.tagFilters.length > 0
          ? { tagFilters: input.tagFilters as unknown as object }
          : {}),
        bbox: input.bbox as unknown as object,
        featureCount: features.length,
        endpoint,
        fetchedAt: new Date(),
        expiresAt,
      },
      update: {
        scope,
        presetIds: input.presetIds,
        ...(input.tagFilters && input.tagFilters.length > 0
          ? { tagFilters: input.tagFilters as unknown as object }
          : { tagFilters: undefined as unknown as object }),
        bbox: input.bbox as unknown as object,
        featureCount: features.length,
        endpoint,
        fetchedAt: new Date(),
        expiresAt,
      },
    });

    return {
      scope,
      featureCount: rawCount,
      cacheHit: false,
      features,
      attribution: ATTRIBUTION,
    };
  }

  /**
   * Reverse-geocode at a point (#152).  Returns every feature at
   * the point (containing admin boundaries, named places, building
   * polygons via Overpass `is_in:`) plus every node/way/relation
   * within `radiusMeters` of the point (`around:`).  Caller ranks
   * the result client-side (typically smallest area first so the
   * building outranks the city outranks the state).
   *
   * Endpoint resolution mirrors resolve() / resolveRelational():
   * explicit override -> per-org setting -> env -> default.  No
   * cache layer in v1: the result is point-keyed and short-lived;
   * the same point twice probably means the user is exploring, in
   * which case Overpass's own internal cache handles the repeat.
   */
  async resolveAtPoint(
    input: OsmReverseGeocodeInput,
  ): Promise<OsmReverseGeocodeResult> {
    if (!Number.isFinite(input.lng) || !Number.isFinite(input.lat)) {
      throw new Error('resolveAtPoint: lng/lat must be finite numbers');
    }
    let endpoint = input.endpoint;
    if (!endpoint && input.orgId) {
      try {
        const org = await this.prisma.organization.findUnique({
          where: { id: input.orgId },
          select: { osmOverpassEndpoint: true },
        });
        if (org?.osmOverpassEndpoint) endpoint = org.osmOverpassEndpoint;
      } catch (err) {
        this.logger.warn(
          `resolveAtPoint: per-org endpoint lookup failed (org ${input.orgId}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    endpoint =
      endpoint ??
      process.env.GRATIS_GIS_OSM_OVERPASS_ENDPOINT ??
      DEFAULT_ENDPOINT;
    const radius = Math.max(1, Math.round(input.radiusMeters ?? 50));
    const maxFeatures = input.maxFeatures ?? 5000;

    const ql = buildReverseGeocodeOverpassQl({
      lng: input.lng,
      lat: input.lat,
      radiusMeters: radius,
      maxFeatures,
      timeoutSeconds: 30,
    });
    this.logger.log(
      `OSM resolveAtPoint: lng=${input.lng} lat=${input.lat} radius=${radius}m`,
    );

    const response = await this.client.run({ endpoint, ql });
    const collection = osmToGeoJson(response);
    return {
      features: collection.features.slice(0, maxFeatures),
      attribution: ATTRIBUTION,
      featureCount: collection.features.length,
    };
  }

  /**
   * Resolve a relational OSM query (#142) in a single Overpass
   * round-trip via the `around:<set>:<distance>` predicate.
   * Anchor + per-condition spatial filters + survivor selection +
   * supporting collection all happen on Overpass's native spatial
   * index, so we trade N+1 fetches + ST_DWithin for one query.
   * The reference patterns live in ldodds/osm-queries/tutorial
   * (around-with-set, radius-search).
   *
   * v1 doesn't cache the relational result; the key shape differs
   * from the per-preset cache, and we'd rather ship a working
   * surface than build relational cache infrastructure speculatively.
   */
  async resolveRelational(
    input: OsmRelationalResolveInput,
  ): Promise<OsmRelationalResolveResult> {
    if (!input.anchorPresetId) {
      throw new Error('resolveRelational: anchorPresetId is required');
    }
    if (!input.conditions || input.conditions.length === 0) {
      throw new Error('resolveRelational: at least one condition is required');
    }
    // Endpoint resolution mirrors resolve(): explicit override ->
    // per-org setting -> env -> default.
    let endpoint = input.endpoint;
    if (!endpoint && input.orgId) {
      try {
        const org = await this.prisma.organization.findUnique({
          where: { id: input.orgId },
          select: { osmOverpassEndpoint: true },
        });
        if (org?.osmOverpassEndpoint) endpoint = org.osmOverpassEndpoint;
      } catch (err) {
        this.logger.warn(
          `resolveRelational: per-org endpoint lookup failed (org ${input.orgId}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    endpoint =
      endpoint ??
      process.env.GRATIS_GIS_OSM_OVERPASS_ENDPOINT ??
      DEFAULT_ENDPOINT;
    const maxFeatures = input.maxFeatures ?? 50000;

    // Resolve preset definitions for the QL builder + the post-fetch
    // tag-based classifier that buckets each returned feature back
    // into its source set.  Includes the negation presets so the
    // QL builder can emit their selector clauses.
    const negations = input.negations ?? [];
    const allPresetIds = [
      input.anchorPresetId,
      ...input.conditions.map((c) => c.presetId),
      ...negations.map((n) => n.presetId),
    ];
    const presets = await getOsmPresets(allPresetIds);
    const byId = new Map(presets.map((p) => [p.id, p]));
    const anchorPreset = byId.get(input.anchorPresetId);
    if (!anchorPreset) {
      throw new Error(
        `resolveRelational: anchor preset '${input.anchorPresetId}' not found`,
      );
    }
    const conditionPresets = input.conditions.map((c, i) => {
      const p = byId.get(c.presetId);
      if (!p) {
        throw new Error(
          `resolveRelational: condition[${i}] preset '${c.presetId}' not found`,
        );
      }
      return {
        preset: p,
        distanceMeters: c.distanceMeters,
        ...(c.tagFilters && c.tagFilters.length > 0
          ? { tagFilters: c.tagFilters }
          : {}),
      };
    });
    const negationPresets = negations.map((n, i) => {
      const p = byId.get(n.presetId);
      if (!p) {
        throw new Error(
          `resolveRelational: negation[${i}] preset '${n.presetId}' not found`,
        );
      }
      return { preset: p, distanceMeters: n.distanceMeters };
    });

    const ql = buildRelationalOverpassQl({
      anchor: anchorPreset,
      conditions: conditionPresets,
      ...(negationPresets.length > 0 ? { negations: negationPresets } : {}),
      bbox: input.bbox,
      maxFeatures,
      timeoutSeconds: 60,
    });
    this.logger.log(
      `OSM resolveRelational: anchor=${input.anchorPresetId} conditions=${input.conditions
        .map((c) => `${c.presetId}@${c.distanceMeters}m`)
        .join(',')} bbox=${input.bbox.join(',')}`,
    );

    const response = await this.client.run({ endpoint, ql });
    const collection = osmToGeoJson(response);

    // Classify by tag-selector match: Overpass emits all output
    // statements concatenated without set-membership markers, so
    // we re-check the preset's tag clauses against each feature
    // to assign it back to its source set.  Anchor classification
    // wins ties; conditions are checked in declaration order.
    const survivingAnchors: OsmGeoJsonFeature[] = [];
    const supportingByCondition: OsmGeoJsonFeature[][] = input.conditions.map(
      () => [],
    );
    const supportingSeen = new Set<string>();
    for (const feat of collection.features) {
      if (featureMatchesPreset(feat, anchorPreset)) {
        survivingAnchors.push(feat);
        continue;
      }
      for (let i = 0; i < conditionPresets.length; i++) {
        if (featureMatchesPreset(feat, conditionPresets[i]!.preset)) {
          const key = `${i}:${feat.id ?? `${i}-${supportingByCondition[i]!.length}`}`;
          if (!supportingSeen.has(key)) {
            supportingSeen.add(key);
            supportingByCondition[i]!.push(feat);
          }
          break;
        }
      }
    }

    return {
      anchor: {
        presetId: anchorPreset.id,
        presetLabel: anchorPreset.label,
        features: survivingAnchors,
      },
      conditions: conditionPresets.map((c, i) => ({
        presetId: c.preset.id,
        presetLabel: c.preset.label,
        distanceMeters: c.distanceMeters,
        supportingCount: supportingByCondition[i]!.length,
        supporting: supportingByCondition[i]!,
      })),
      supporting: supportingByCondition.flat(),
      attribution: ATTRIBUTION,
      featureCount: collection.features.length,
    };
  }

  /**
   * Write a GeoJSON FeatureCollection into the observation log
   * under the given scope.  Each Feature becomes a single
   * `create` observation; the scope is a transient namespace
   * that the cache scrub job tears down when the cache row
   * expires.
   *
   * The observation table is huge in prod (multi-million-row
   * data_layer scopes share the partition set), and a
   * `DELETE WHERE scope = $1` on a brand-new scope would still
   * scan partitions and bump into the per-request
   * statement_timeout (#OSM hotfix 2026-05-25).  Skip the
   * defensive clean-up; rely on the read path's
   * `DISTINCT ON (entity) ORDER BY valid_from DESC, tx_time DESC`
   * to ensure the latest observation wins.  Re-resolutions
   * under the same hash mint fresh UUIDv7 entity ids, so any
   * leftover rows from an expired-and-re-fetched scope sort
   * older and fall out naturally; the (future) scrub job that
   * trims expired cache rows is responsible for reclaiming the
   * storage.
   */
  private async writeFeaturesToScope(
    scope: string,
    features: OsmGeoJsonFeature[],
  ): Promise<void> {
    if (features.length === 0) return;

    // The osm-bot principal carries every OSM-derived observation.
    // Real users never write to OSM scopes; the engine's writeable
    // surfaces are scoped by data_layer item id and never touch
    // `osm:*`.
    const author = { sub: 'osm-bot', displayName: 'OpenStreetMap import' };
    const now = new Date();

    for (const feat of features) {
      // Deterministic entity id derived from (scope, feature.id).
      // Same OSM feature in the same scope across two resolves -> same
      // entity -> the read path's `DISTINCT ON (entity) ORDER BY
      // valid_from DESC` keeps the newer observation.  Different OSM
      // features -> different entity -> both surface.  Without this,
      // a re-resolve after TTL expiry would double-count features
      // because UUIDv7 mints a fresh id every time.
      const entity = osmEntityIdFor(scope, String(feat.id ?? ''));
      await this.engine.write({
        scope,
        entity,
        kind: 'create',
        validFrom: now,
        validTo: null,
        geom: (feat.geometry as unknown) ?? null,
        attrs: (feat.properties as Record<string, unknown> | null) ?? null,
        author,
        source: { kind: 'osm-overpass', queryScope: scope },
        parents: [],
      } as unknown as Parameters<EngineService['write']>[0]);
    }
  }

  /**
   * Pull the materialised features back out of the observation log
   * scope as GeoJSON Features.  Used on cache hits when the
   * recipe-runner caller wants the features inline (the
   * osm-features-overlay output sink does).
   */
  private async readFeaturesFromScope(scope: string): Promise<OsmGeoJsonFeature[]> {
    type Row = {
      entity: string;
      geom: string | null;
      attrs: Record<string, unknown> | null;
    };
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT entity, ST_AsGeoJSON(geom) AS geom, attrs
      FROM (
        SELECT DISTINCT ON (entity)
          entity, geom, attrs, kind, valid_from, tx_time
        FROM observation
        WHERE scope = ${scope}
        ORDER BY entity, valid_from DESC, tx_time DESC
      ) latest
      WHERE kind <> 'delete'
    `;
    return rows.map((r) => ({
      type: 'Feature' as const,
      id: r.entity,
      geometry: r.geom ? (JSON.parse(r.geom) as OsmGeoJsonGeometry) : (null as unknown as OsmGeoJsonGeometry),
      properties: r.attrs ?? {},
    }));
  }
}

/**
 * Deterministic content hash for the cache key.  Rounds bbox to
 * ~5 decimal places (about 1m at the equator) so a fractionally-
 * different AOI redraw still hits the same cache row.  Sorts tag
 * filters so the call-site iteration order doesn't fragment the
 * cache key.
 */
function hashQuery(input: OsmSourceResolveInput, endpoint: string): string {
  const rounded = input.bbox.map((x) => Math.round(x * 1e5) / 1e5);
  const sortedFilters = (input.tagFilters ?? [])
    .slice()
    .sort((a, b) =>
      a.key === b.key
        ? a.value.localeCompare(b.value)
        : a.key.localeCompare(b.key),
    );
  const tuple = JSON.stringify({
    p: input.presetIds.slice().sort(),
    t: sortedFilters,
    b: rounded,
    e: endpoint,
  });
  return createHash('sha256').update(tuple).digest('hex').slice(0, 32);
}

/**
 * Tag-based preset classifier (#142).  Returns true when every tag
 * clause on the preset is satisfied by the feature's properties.
 * Wildcard values (`*`) match any non-null value for the key, which
 * matches the iD catalog convention used by the QL builder.
 *
 * Used by resolveRelational to bucket Overpass's concatenated
 * output back into the anchor / supporting groups, since Overpass
 * doesn't tag features with set membership on output.
 */
function featureMatchesPreset(
  feature: OsmGeoJsonFeature,
  preset: OsmPreset,
): boolean {
  const props = feature.properties ?? {};
  for (const tag of preset.tags) {
    const v = props[tag.key];
    if (tag.value === '*') {
      if (v == null || v === '') return false;
    } else {
      if (v !== tag.value) return false;
    }
  }
  return true;
}

/**
 * Deterministic entity id for an OSM feature inside a scope.  The
 * id only has to pass the engine's UUID shape check (8-4-4-4-12
 * hex); we don't need real v5 namespace semantics.  Hashing
 * (scope, featureId) and formatting as a UUID-shaped string gives
 * us "same OSM feature in same scope = same entity" which the
 * read path's DISTINCT ON resolves to a single latest row.
 */
function osmEntityIdFor(scope: string, featureId: string): string {
  const hex = createHash('sha256')
    .update(scope)
    .update(':')
    .update(featureId)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
