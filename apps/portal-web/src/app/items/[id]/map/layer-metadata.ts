import type { MapLayer } from '@gratis-gis/shared-types';

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
      // ArcGIS REST: pull a representative sample (no bbox filter)
      // to light up field/value discovery. We deliberately fetch
      // outside the map bbox so filters & the attribute table have
      // something to work with even when the user hasn't panned to
      // a region with features yet. The live draw path still does
      // its own bbox queries.
      const params = new URLSearchParams({
        where: '1=1',
        outFields: '*',
        outSR: '4326',
        f: 'geojson',
        resultRecordCount: String(FEATURE_SAMPLE_CAP),
      });
      const url = `${layer.source.url}/${layer.source.layerId}/query?${params.toString()}`;
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
  }

  const fields = [...fieldSet].sort();
  const withProps = features.find(
    (f) => f.properties && Object.keys(f.properties).length > 0,
  );
  const featureCollection =
    raw && typeof raw === 'object' && (raw as { type?: string }).type === 'FeatureCollection'
      ? (raw as GeoJSON.FeatureCollection)
      : null;
  const out: LayerMetadata = {
    fields,
    valuesByField: Object.fromEntries(
      Object.entries(valuesByField).map(([k, set]) => [k, [...set].sort()]),
    ),
    sampleProperties: withProps?.properties ?? null,
    featureCollection,
    geometryTypes,
    error: null,
    loading: false,
  };
  return out;
}

/**
 * True when the layer has finished loading and turned out to carry no
 * geometry: a "table" sublayer (#73). ArcGIS feature services often
 * include non-spatial tables alongside their spatial layers; the user
 * may want them on the map's data side for the attribute table even
 * though they don't render. The cartographic editors and the legend
 * use this signal to suppress controls that would never apply.
 *
 * Distinct from "still loading" (geometryTypes empty because we
 * haven't fetched yet): we check that the feature collection is
 * resolved AND geometryTypes is empty. While loading we err toward
 * showing controls so the editor doesn't flicker.
 */
export function isTableLayer(metadata: LayerMetadata): boolean {
  return (
    !metadata.loading &&
    metadata.featureCollection !== null &&
    metadata.geometryTypes.size === 0
  );
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
