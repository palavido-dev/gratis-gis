// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MapLayer } from '@gratis-gis/shared-types';
import { prefetchUserNames } from '@/lib/user-name-cache';

export type GeometryFamily = 'point' | 'line' | 'polygon';

export interface LayerMetadata {
  /** Distinct property keys seen on features. Sorted alphabetically. */
  fields: string[];
  /** Cached distinct values per field (capped at 64 per field to stay bounded). */
  valuesByField: Record<string, string[]>;
  /**
   * A real feature's property bag, used to power live previews in the
   * popup / label editors. Null if the layer is empty or pre-load.
   */
  sampleProperties: Record<string, unknown> | null;
  /**
   * Full feature collection. Cached on the editor side so the
   * attribute table and other feature-consumers don't need to re-
   * fetch. Null means the layer has not finished loading yet, or the
   * source (e.g. still-pending feature-service) hasn't resolved.
   */
  featureCollection: GeoJSON.FeatureCollection | null;
  /**
   * Geometry families present in the sampled features. Drives the
   * geometry-aware UI: symbology and legend hide the sections that
   * don't apply. Multi* geometries unwrap to their base family.
   * Empty set while metadata is still loading.
   */
  geometryTypes: Set<GeometryFamily>;
  /**
   * Authoritative "this layer has no geometry" flag (#87). Set
   * directly from the layer's canonical metadata when we can read
   * it (arcgis-rest /N?f=json returns geometryType === null /
   * undefined for table sublayers). Distinct from
   * geometryTypes.size === 0 which can mean "no features sampled
   * yet" or "fetch failed". When true, isTableLayer returns true
   * regardless of what the user has done to the layer's display
   * title.
   */
  isTable: boolean;
  /** Friendly note the UI can surface when discovery fails. */
  error: string | null;
  /** True while a fetch is in flight. */
  loading: boolean;
}

const EMPTY: LayerMetadata = {
  fields: [],
  valuesByField: {},
  sampleProperties: null,
  featureCollection: null,
  geometryTypes: new Set<GeometryFamily>(),
  isTable: false,
  error: null,
  loading: false,
};
const FEATURE_SAMPLE_CAP = 5000;
const VALUES_PER_FIELD_CAP = 64;

/**
 * Fetches or reads the layer's underlying GeoJSON, collects the set of
 * property keys, and builds a small per-field distinct-value cache used
 * by the filter picker and the unique-values renderer.
 *
 * Bounds:
 *   - We sample up to FEATURE_SAMPLE_CAP features to keep discovery
 *     snappy on large datasets (the editor UI doesn't need exhaustive
 *     stats; it needs "what can I filter by").
 *   - We cap distinct values per field at VALUES_PER_FIELD_CAP. If a
 *     field has more, the UI flags "too many unique values for a
 *     categorical renderer" rather than pretending to list them all.
 */
export async function discoverLayerMetadata(
  layer: MapLayer,
  signal?: AbortSignal,
): Promise<LayerMetadata> {
  let raw: unknown;
  try {
    if (layer.source.kind === 'group') {
      // Group layers are pure UI markers; nothing to discover.
      return EMPTY;
    } else if (layer.source.kind === 'point-cloud') {
      // #179 unit 3: point clouds have no feature attributes to
      // discover; probing the streaming endpoint for geojson would
      // download binary. Everything the UI needs is stamped on the
      // source.
      return EMPTY;
    } else if (layer.source.kind === 'geojson-inline') {
      raw = layer.source.geojson;
    } else if (layer.source.kind === 'arcgis-rest') {
      // ArcGIS REST: first read the layer's authoritative metadata
      // (/N?f=json) so we know whether it's a spatial layer or a
      // non-spatial table BEFORE we try to fetch features. ArcGIS
      // marks tables with `geometryType` missing or
      // `esriGeometryNull`, which is the most reliable signal for
      // suppressing symbology / legend / etc. The features query
      // for a table often errors out on `f=geojson` so we skip it
      // entirely when we know it's a table. (#87)
      //
      // Route through the portal-api proxy when the source item is
      // credentialed (#36); the proxy attaches the stored
      // credential server-side. Without this, secured services
      // return Esri's JSON error body (200 + {error:{code:401}}),
      // which parses cleanly but has no geometryType -- so EVERY
      // layer would have looked like a table.
      const baseUrl =
        (layer.source as { proxyUrl?: string }).proxyUrl ?? layer.source.url;
      const descUrl = `${baseUrl}/${layer.source.layerId}?f=json`;
      const descInit: RequestInit = {};
      if (signal) descInit.signal = signal;
      type LayerDesc = {
        geometryType?: string | null;
        type?: string;
        fields?: Array<{ name?: unknown }>;
        // Esri's failure shape: HTTP 200 with this object instead
        // of the layer description. We treat its presence as a
        // signal that the desc fetch effectively failed.
        error?: { code?: number; message?: string };
      };
      let layerDesc: LayerDesc | null = null;
      try {
        const descRes = await fetch(descUrl, descInit);
        if (descRes.ok) {
          const parsed = (await descRes.json()) as LayerDesc;
          // Reject Esri error envelopes here so the geometryType
          // missing branch can trust that null = table, not auth
          // failure.
          if (!parsed.error) layerDesc = parsed;
        }
      } catch {
        // Non-fatal: fall through to the features query path. If
        // the upstream is unreachable, the features query will
        // fail too and surface a real error then.
      }
      const isArcgisTable =
        layerDesc !== null &&
        (layerDesc.type === 'Table' ||
          !layerDesc.geometryType ||
          layerDesc.geometryType === 'esriGeometryNull');
      if (isArcgisTable) {
        // Skip the features query: ArcGIS often refuses
        // f=geojson against a table. We still want fields though,
        // so hit the description's fields list if present, or
        // leave it empty -- the attribute table can fetch lazily.
        const fieldsRaw = layerDesc?.fields;
        const fieldNames = Array.isArray(fieldsRaw)
          ? fieldsRaw
              .map((f) => (typeof f.name === 'string' ? f.name : null))
              .filter((n): n is string => n !== null)
          : [];
        return {
          ...EMPTY,
          fields: fieldNames.sort(),
          isTable: true,
          loading: false,
        };
      }
      const params = new URLSearchParams({
        where: '1=1',
        outFields: '*',
        outSR: '4326',
        f: 'geojson',
        resultRecordCount: String(FEATURE_SAMPLE_CAP),
      });
      const url = `${baseUrl}/${layer.source.layerId}/query?${params.toString()}`;
      const init: RequestInit = {};
      if (signal) init.signal = signal;
      const res = await fetch(url, init);
      if (!res.ok) {
        return { ...EMPTY, error: `ArcGIS service returned ${res.status}` };
      }
      raw = await res.json();
    } else if (
      layer.source.kind === 'data-layer' &&
      typeof layer.source.layerKey === 'string' &&
      layer.source.layerKey.length > 0
    ) {
      // v3 sublayer. Three changes from the v1/v2 path:
      //
      // 1. Hit /items/:id/layers/:layerKey/geojson (the per-sublayer
      //    endpoint), not /items/:id/geojson (which only works for
      //    legacy single-table items).
      // 2. Consult the parent item's sublayer descriptor for the
      //    authoritative geometryType. The features-driven
      //    "geometryTypes.size === 0 -> table" inference is wrong
      //    for a freshly-created spatial layer that just hasn't had
      //    a feature added yet -- without this preempt, every empty
      //    point/line/polygon sublayer renders as a non-spatial
      //    table in the layer panel.
      // 3. Also pull the sublayer's `fields[]` schema from the same
      //    parent-item fetch. v3 sublayers carry their authoritative
      //    field list in their item data; the features-driven loop
      //    below is only useful for valuesByField. Using the schema
      //    means the labels editor + search-bar field-inserter
      //    dropdowns appear instantly, even when the /geojson sample
      //    is still in flight or has failed against a giant layer
      //    (see #145).
      const itemId = layer.source.itemId;
      const layerKey = layer.source.layerKey;
      let declaredGeometry: 'point' | 'line' | 'polygon' | null | undefined;
      // Schema-direct fields. Captured here, applied to fieldSet
      // before the (slower, optional) geojson sample. Empty for
      // legacy items that don't carry per-layer `fields[]`.
      const schemaFields: string[] = [];
      try {
        const descInit: RequestInit = {};
        if (signal) descInit.signal = signal;
        const descRes = await fetch(`/api/portal/items/${itemId}`, descInit);
        if (descRes.ok) {
          const item = (await descRes.json()) as {
            data?: {
              version?: number;
              layers?: Array<{
                id?: string;
                geometryType?: 'point' | 'line' | 'polygon' | null;
                fields?: Array<{ name?: unknown }>;
              }>;
            };
          };
          const sub = item.data?.layers?.find((l) => l.id === layerKey);
          if (sub) {
            declaredGeometry = sub.geometryType ?? null;
            if (Array.isArray(sub.fields)) {
              for (const f of sub.fields) {
                if (typeof f.name === 'string' && f.name.length > 0) {
                  schemaFields.push(f.name);
                }
              }
            }
          }
        }
      } catch {
        // Fall through to the features fetch; if that errors too the
        // user sees a generic discovery error.
      }
      if (declaredGeometry === null) {
        // Authoritative table sublayer. The v3 geojson endpoint
        // refuses geojson on tables anyway. Return the schema-
        // derived fields so the inline editor can resolve them;
        // cartographic editors stay hidden via isTable=true.
        return {
          ...EMPTY,
          fields: [...schemaFields].sort(),
          isTable: true,
          loading: false,
        };
      }
      // SKIP the /geojson sample on v3 data layers entirely.
      //
      // The sample was originally needed for:
      //   - valuesByField (distinct values per field, used by the
      //     unique-values renderer's category picker)
      //   - sampleProperties (one feature's props, used by the
      //     popup live-preview)
      //   - featureCollection (cached at the metadata level for
      //     downstream consumers like search bar + attribute table)
      //
      // Each of those was acceptable on small layers and a
      // catastrophe on big ones. The 1.4M-row parcels dataset
      // either 500s the /geojson endpoint outright (Postgres SHM
      // pressure, OOM during JSON serialization) or returns a
      // multi-gigabyte response that wedges the browser. There is
      // no scenario where the sample is useful enough to justify
      // those failure modes for the common authoring flows.
      //
      // What we return instead:
      //   - fields: the schema-declared field list (always
      //     reliable; comes from the parent item descriptor).
      //   - geometryTypes: the declared geometry family.
      //   - valuesByField: empty. The unique-values renderer's
      //     category picker becomes a follow-up "fetch on demand
      //     via /features-page?distinct=field" endpoint; for now
      //     it shows "no distinct values cached yet" instead of
      //     hanging the page.
      //   - sampleProperties: null. Popup live-preview falls back
      //     to placeholder text until the user hovers a real
      //     feature on the map.
      //   - featureCollection: null. Downstream consumers that
      //     wanted full-layer feature data already moved off this
      //     cache (attribute table -> /features-page, search bar
      //     -> /features-page).
      //
      // This is the same architectural call as the attribute-
      // table P13 fix: schema-direct beats full-table sample.
      return {
        ...EMPTY,
        fields: [...schemaFields].sort(),
        geometryTypes:
          declaredGeometry === 'point' ||
          declaredGeometry === 'line' ||
          declaredGeometry === 'polygon'
            ? new Set([declaredGeometry])
            : new Set<GeometryFamily>(),
        loading: false,
      };
    } else if (layer.source.kind === 'postgis-live') {
      // #158 postgis-live layers fetch features via the bbox-
      // driven effect on the map canvas; the metadata loader
      // can't materialize a full sample (the table may be
      // millions of rows). Return an empty default — the user
      // sees fields show up once the canvas hits the first
      // viewport-bound features endpoint.
      return { ...EMPTY, loading: false };
    } else {
      const url =
        layer.source.kind === 'geojson-url'
          ? layer.source.url
          : `/api/portal/items/${layer.source.itemId}/geojson`;
      const init: RequestInit = {};
      if (signal) init.signal = signal;
      const res = await fetch(url, init);
      if (!res.ok) {
        return { ...EMPTY, error: `Source returned ${res.status}` };
      }
      raw = await res.json();
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return EMPTY;
    return {
      ...EMPTY,
      error: err instanceof Error ? err.message : 'Failed to fetch source',
    };
  }

  const features =
    (
      raw as {
        features?: Array<{
          properties?: Record<string, unknown>;
          geometry?: { type?: string } | null;
        }>;
      }
    )?.features ?? [];

  const fieldSet = new Set<string>();
  // Seed schema-declared fields (v3 data-layer path only; other
  // sources omit this). Ensures the inserter dropdowns see every
  // declared column even when the feature sample is empty or sparse.
  const schemaFields =
    raw && typeof raw === 'object'
      ? (raw as { __schemaFields?: string[] }).__schemaFields
      : undefined;
  if (Array.isArray(schemaFields)) {
    for (const name of schemaFields) fieldSet.add(name);
  }
  const valuesByField: Record<string, Set<string>> = {};
  const geometryTypes = new Set<GeometryFamily>();

  const sampleSlice = features.slice(0, FEATURE_SAMPLE_CAP);
  // Editor-tracking UUIDs we encounter while sampling. We queue
  // them for batch resolution at the end so the popup renderer can
  // surface display names instead of raw uuids when a feature is
  // clicked. One de-duplicated set per probe; the cache itself
  // dedupes across probes.
  const editorUserIds = new Set<string>();
  for (const f of sampleSlice) {
    const fam = geometryFamily(f.geometry?.type);
    if (fam) geometryTypes.add(fam);
    const props = f.properties ?? {};
    for (const key of Object.keys(props)) {
      fieldSet.add(key);
      const v = props[key];
      if (v === null || v === undefined) continue;
      if (typeof v === 'object') continue; // skip nested objects
      const s = String(v);
      let set = valuesByField[key];
      if (!set) {
        set = new Set();
        valuesByField[key] = set;
      }
      if (set.size < VALUES_PER_FIELD_CAP) set.add(s);
    }
    const createdBy = props['_created_by'];
    const editedBy = props['_edited_by'];
    if (typeof createdBy === 'string' && createdBy) {
      editorUserIds.add(createdBy);
    }
    if (typeof editedBy === 'string' && editedBy) {
      editorUserIds.add(editedBy);
    }
  }
  if (editorUserIds.size > 0) prefetchUserNames(editorUserIds);

  const fields = [...fieldSet].sort();
  const withProps = features.find(
    (f) => f.properties && Object.keys(f.properties).length > 0,
  );
  const featureCollection =
    raw && typeof raw === 'object' && (raw as { type?: string }).type === 'FeatureCollection'
      ? (raw as GeoJSON.FeatureCollection)
      : null;
  // If the v3 path stashed a declared geometry on the raw payload
  // (the parent item said "this sublayer is a point/line/polygon"
  // even though we sampled zero features), seed geometryTypes from
  // it. Without this an empty spatial sublayer would slip into the
  // isTable branch below.
  const declaredGeometry =
    raw && typeof raw === 'object'
      ? (raw as { __declaredGeometry?: GeometryFamily }).__declaredGeometry
      : undefined;
  if (declaredGeometry && geometryTypes.size === 0) {
    geometryTypes.add(declaredGeometry);
  }
  // Loaded successfully but no geometry showed up: this is a
  // table, even if the source isn't arcgis-rest. Catches the
  // geojson-url case where someone hands us an attribute-only
  // FeatureCollection (rare but possible). Empty v3 spatial
  // sublayers are excluded by the declaredGeometry seed above.
  const isTable =
    featureCollection !== null && geometryTypes.size === 0;
  const out: LayerMetadata = {
    fields,
    valuesByField: Object.fromEntries(
      Object.entries(valuesByField).map(([k, set]) => [k, [...set].sort()]),
    ),
    sampleProperties: withProps?.properties ?? null,
    featureCollection,
    geometryTypes,
    isTable,
    error: null,
    loading: false,
  };
  return out;
}

/**
 * True when the layer is a "table" with no geometry (#73, #87).
 * Reads the canonical isTable flag set by the metadata fetcher
 * from the layer's authoritative description (e.g. ArcGIS REST
 * /N?f=json's geometryType). This is independent of the layer's
 * editable display title -- renaming "PARCELS (table)" to just
 * "PARCELS" doesn't change whether it has geometry.
 *
 * Layer arg kept for the call sites that want to forward extra
 * info in the future (geo_boundary, file, etc.); unused here.
 */
export function isTableLayer(
  _layer: { title: string },
  metadata: LayerMetadata,
): boolean {
  return metadata.isTable;
}

/**
 * Synchronous version of the feature-walking discovery, for callers
 * that already have a FeatureCollection in memory (e.g. the OSM
 * tool-run result in the Custom App runtime, or any other inline
 * source we don't need to fetch). Mirrors what `discoverLayerMetadata`
 * does for the geojson-inline branch but skips the async fetch path,
 * so AttributeTable / SearchBar can populate column lists +
 * filterable distinct values in a useMemo without an effect.
 *
 * Bounds: same FEATURE_SAMPLE_CAP and VALUES_PER_FIELD_CAP caps as
 * the async discovery path, so we don't blow up on a 100k-feature
 * inline FC.
 */
export function metadataFromFeatureCollection(
  fc: GeoJSON.FeatureCollection | null | undefined,
): LayerMetadata {
  if (!fc || !Array.isArray(fc.features)) return EMPTY;
  const features = fc.features.slice(0, FEATURE_SAMPLE_CAP);
  const fieldSet = new Set<string>();
  const valuesByField: Record<string, Set<string>> = {};
  const geometryTypes = new Set<GeometryFamily>();
  for (const f of features) {
    const fam = geometryFamily(f.geometry?.type);
    if (fam) geometryTypes.add(fam);
    const props = (f.properties ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(props)) {
      fieldSet.add(key);
      const v = props[key];
      if (v === null || v === undefined) continue;
      if (typeof v === 'object') continue;
      const s = String(v);
      let set = valuesByField[key];
      if (!set) {
        set = new Set();
        valuesByField[key] = set;
      }
      if (set.size < VALUES_PER_FIELD_CAP) set.add(s);
    }
  }
  const fields = [...fieldSet].sort();
  const sampleProperties =
    (features.find(
      (f) => f.properties && Object.keys(f.properties).length > 0,
    )?.properties as Record<string, unknown> | undefined) ?? null;
  return {
    fields,
    valuesByField: Object.fromEntries(
      Object.entries(valuesByField).map(([k, set]) => [k, [...set].sort()]),
    ),
    sampleProperties,
    featureCollection: fc,
    geometryTypes,
    // Inline FC with no geometry = table. Inline FC with at least
    // one geometry sample = spatial layer.
    isTable: geometryTypes.size === 0 && fc.features.length > 0,
    error: null,
    loading: false,
  };
}

function geometryFamily(type?: string): GeometryFamily | null {
  switch (type) {
    case 'Point':
    case 'MultiPoint':
      return 'point';
    case 'LineString':
    case 'MultiLineString':
      return 'line';
    case 'Polygon':
    case 'MultiPolygon':
      return 'polygon';
    default:
      return null;
  }
}
