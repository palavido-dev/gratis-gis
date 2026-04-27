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
  // Loaded successfully but no geometry showed up: this is a
  // table, even if the source isn't arcgis-rest. Catches the
  // geojson-url case where someone hands us an attribute-only
  // FeatureCollection (rare but possible).
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
