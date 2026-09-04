// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Two shaped-identically search sources powering the map's search bar:
 *
 *   1. Attribute search over each layer's cached FeatureCollection.
 *      Walks features looking for substring matches against whichever
 *      fields the layer owner marked as searchable. Fast; works
 *      entirely client-side.
 *
 *   2. Geocoding via Nominatim (https://nominatim.openstreetmap.org/).
 *      Free, no API key, rate-limited to 1 req/sec per their policy
 *      so we debounce in the UI. We send a descriptive User-Agent as
 *      required, credit OSM in the results footer, and do NOT cache
 *      beyond the single session.
 */

import type { MapLayer } from '@gratis-gis/shared-types';

export type SearchResult =
  | {
      kind: 'feature';
      layerId: string;
      layerTitle: string;
      label: string;
      subtitle: string | null;
      /** Preferred: a bounding box of the hit feature. */
      bbox: [number, number, number, number] | null;
      /** Fallback for a bare-point hit: a center coordinate + default zoom. */
      center: [number, number] | null;
      /**
       * The full GeoJSON feature so the canvas can highlight it by
       * matching against the source data. Kept on the result because a
       * layer may contain thousands of features and we don't want to
       * look it up by id again.
       */
      feature: GeoJSON.Feature;
    }
  | {
      kind: 'place';
      label: string;
      subtitle: string | null;
      bbox: [number, number, number, number] | null;
      center: [number, number] | null;
    };

const MAX_ATTRIBUTE_HITS_PER_LAYER = 8;
/**
 * Client talks to our own proxy, not Nominatim directly. The proxy
 * (apps/portal-web/src/app/api/geocode/route.ts) forwards to whatever
 * NOMINATIM_URL is configured for the deployment: local docker
 * container for self-hosted, a regional cluster in prod, or the
 * public OSM endpoint for demos. Doing it this way keeps one env var
 * as the swap point, lets us set the required User-Agent from Node,
 * and leaves an obvious spot to add caching / rate limits.
 */
const GEOCODE_URL = '/api/geocode';

/**
 * Rank layer features by how well they match `query`. Each result
 * carries the layer it came from so the UI can group/prefix.
 */
export function searchLayers(
  query: string,
  layers: MapLayer[],
  featuresByLayer: Record<string, GeoJSON.FeatureCollection | null>,
): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: SearchResult[] = [];

  for (const layer of layers) {
    if (!layer.search?.enabled) continue;
    // Honour server-enforced matrix permissions: a layer the viewer
    // has view-only access to shouldn't surface feature attributes
    // through search any more than through a popup.
    if (layer.effective && layer.effective.query === false) continue;
    const fields = layer.search.fields.filter((f) => f.length > 0);
    if (fields.length === 0) continue;
    // ArcGIS-REST layers only have the visible viewport's features in
    // the local cache; we'd miss matches outside the camera's bbox.
    // Those layers are handled by searchArcgisLayers(), which queries
    // the origin directly with a WHERE clause against the whole
    // dataset.
    if (layer.source.kind === 'arcgis-rest') continue;
    const fc = featuresByLayer[layer.id];
    if (!fc) continue;

    let layerHits = 0;
    for (const f of fc.features) {
      if (layerHits >= MAX_ATTRIBUTE_HITS_PER_LAYER) break;
      const props = (f.properties ?? {}) as Record<string, unknown>;
      let matched = false;
      for (const field of fields) {
        const v = props[field];
        if (v === null || v === undefined) continue;
        if (String(v).toLowerCase().includes(q)) {
          matched = true;
          break;
        }
      }
      if (!matched) continue;

      const label = layer.search.labelTemplate
        ? renderTemplate(layer.search.labelTemplate, props)
        : firstNonEmpty(fields.map((ff) => props[ff])) ?? '(unnamed)';
      out.push({
        kind: 'feature',
        layerId: layer.id,
        layerTitle: layer.title,
        label,
        subtitle: fields
          .map((ff) => {
            const val = props[ff];
            return val ? `${ff}: ${val}` : null;
          })
          .filter(Boolean)
          .join(' · ') || null,
        bbox: featureBbox(f),
        center: featureCenter(f),
        feature: f,
      });
      layerHits += 1;
    }
  }
  return out;
}

/**
 * Search ArcGIS REST layers by hitting each service's /query endpoint
 * with a WHERE clause against the layer's configured searchable
 * fields. Unlike the local-cache search above this reaches features
 * that aren't in the current viewport: important because ArcGIS-REST
 * layers only have the last bbox query in memory, and a hit like a
 * parcel APN is almost never visible when the user starts typing.
 *
 * We try a case-insensitive LIKE first (UPPER on both sides of the
 * comparison) and fall back to a plain LIKE if the server rejects
 * UPPER. Numeric columns still match when the query is itself
 * numeric since ArcGIS implicitly coerces the right-hand side. Single
 * quotes in the query are doubled per standard SQL escaping.
 *
 * Per-layer failures are logged to the console and swallowed: one
 * misconfigured field shouldn't nuke search for the rest of the map.
 */
export async function searchArcgisLayers(
  query: string,
  layers: MapLayer[],
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) return [];

  const tasks = layers
    .filter(
      (l) =>
        l.search?.enabled &&
        l.search.fields.length > 0 &&
        l.source.kind === 'arcgis-rest' &&
        // Same matrix-enforcement gate as the local search path.
        (l.effective === undefined || l.effective.query !== false),
    )
    .map(async (layer) => {
      const src = layer.source as {
        kind: 'arcgis-rest';
        url: string;
        layerId: number;
      };
      const fields = layer.search!.fields.filter((f) => f.length > 0);
      const safeQ = q.replace(/'/g, "''");
      // Try two WHERE forms in order:
      //   1. Case-insensitive LIKE via UPPER() on both sides. Works on
      //      any string-typed column where the server's standardized
      //      SQL allows UPPER.
      //   2. Plain LIKE without UPPER. Works on strings where UPPER
      //      isn't allowed (some file-geodatabase services), and on
      //      numeric columns when the query is itself numeric (ArcGIS
      //      implicitly coerces the right-hand side).
      // Earlier iterations wrapped each field in CAST(... AS VARCHAR)
      // to paper over numeric columns, but enough ArcGIS deployments
      // reject that syntax that it did more harm than good.
      const buildWhere = (wrapper: (f: string) => string) =>
        fields
          .map((f) => `${wrapper(f)} LIKE ${wrapper(`'%${safeQ}%'`)}`)
          .join(' OR ');
      const attempts = [
        buildWhere((s) => `UPPER(${s})`),
        buildWhere((s) => s),
      ];
      const tryQuery = async (
        where: string,
      ): Promise<{ fc: GeoJSON.FeatureCollection | null; err: string | null }> => {
        const params = new URLSearchParams({
          where,
          outFields: '*',
          outSR: '4326',
          returnGeometry: 'true',
          f: 'geojson',
          resultRecordCount: String(MAX_ATTRIBUTE_HITS_PER_LAYER),
        });
        const url = `${src.url}/${src.layerId}/query?${params}`;
        const init: RequestInit = signal ? { signal } : {};
        const res = await fetch(url, init);
        if (!res.ok) return { fc: null, err: `HTTP ${res.status}` };
        const j = (await res.json()) as GeoJSON.FeatureCollection & {
          error?: { message?: string };
        };
        if (j.error) return { fc: null, err: j.error.message ?? 'error' };
        if (j.type !== 'FeatureCollection') {
          return { fc: null, err: 'non-FeatureCollection response' };
        }
        return { fc: j, err: null };
      };
      try {
        let fc: GeoJSON.FeatureCollection | null = null;
        let lastErr: string | null = null;
        for (const where of attempts) {
          const result = await tryQuery(where);
          if (result.fc) {
            fc = result.fc;
            break;
          }
          lastErr = result.err;
        }
        if (!fc) {
          // eslint-disable-next-line no-console
          console.warn(
            `[search] ${layer.title}:`,
            lastErr ?? 'all query variants failed',
          );
          return [] as SearchResult[];
        }
        return fc.features.slice(0, MAX_ATTRIBUTE_HITS_PER_LAYER).map(
          (f): SearchResult => {
            const props = (f.properties ?? {}) as Record<string, unknown>;
            const label = layer.search!.labelTemplate
              ? renderTemplate(layer.search!.labelTemplate, props)
              : firstNonEmpty(fields.map((ff) => props[ff])) ?? '(unnamed)';
            return {
              kind: 'feature',
              layerId: layer.id,
              layerTitle: layer.title,
              label,
              subtitle:
                fields
                  .map((ff) => {
                    const val = props[ff];
                    return val ? `${ff}: ${val}` : null;
                  })
                  .filter(Boolean)
                  .join(' · ') || null,
              bbox: featureBbox(f),
              center: featureCenter(f),
              feature: f,
            };
          },
        );
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          return [] as SearchResult[];
        }
        // eslint-disable-next-line no-console
        console.warn(`[search] ${layer.title}:`, (err as Error).message);
        return [] as SearchResult[];
      }
    });

  const perLayer = await Promise.all(tasks);
  return perLayer.flat();
}

/**
 * Search portal-hosted v3 data layers (`source.kind === 'data-layer'`)
 * by hitting the dedicated /features-search endpoint.
 *
 * This is the data-layer analogue of searchArcgisLayers(): both reach
 * features the local-cache searchLayers() can't, because the relevant
 * features aren't in memory. v3 data layers stream as vector tiles and
 * are never loaded as a full FeatureCollection client-side, so without
 * this path attribute search over a v3 layer finds nothing even though
 * the layer is marked searchable. The owner parcel a user types is
 * almost never on screen when they start typing, which is exactly why
 * the search runs server-side over the whole layer.
 *
 * The endpoint already enforces read access + the share's geo-limit and
 * returns a representative point + envelope per hit, so the result can
 * fly the camera and drop a marker. Per-layer failures are logged and
 * swallowed: one slow or misconfigured layer shouldn't sink search for
 * the rest of the map.
 */
export async function searchV3Layers(
  query: string,
  layers: MapLayer[],
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) return [];

  const tasks = layers
    .filter(
      (l) =>
        l.source.kind === 'data-layer' &&
        // Only v3 multi-layer sublayers carry a layerKey and back the
        // per-sublayer endpoints. v1/v2 single-table items omit it and
        // aren't served by /features-search.
        (l.source as { layerKey?: string }).layerKey !== undefined &&
        l.search?.enabled &&
        l.search.fields.filter((f) => f.length > 0).length > 0 &&
        // Same matrix-enforcement gate as the other search paths.
        (l.effective === undefined || l.effective.query !== false),
    )
    .map(async (layer) => {
      const src = layer.source as {
        kind: 'data-layer';
        itemId: string;
        layerKey?: string;
      };
      const fields = layer.search!.fields.filter((f) => f.length > 0);
      const params = new URLSearchParams({
        q,
        fields: fields.join(','),
        limit: String(MAX_ATTRIBUTE_HITS_PER_LAYER),
      });
      const url = `/api/portal/items/${encodeURIComponent(
        src.itemId,
      )}/layers/${encodeURIComponent(src.layerKey!)}/features-search?${params.toString()}`;
      const init: RequestInit = { headers: { Accept: 'application/json' } };
      if (signal) init.signal = signal;
      try {
        const res = await fetch(url, init);
        if (!res.ok) {
          // eslint-disable-next-line no-console
          console.warn(`[search] ${layer.title}: HTTP ${res.status}`);
          return [] as SearchResult[];
        }
        const body = (await res.json()) as {
          results: Array<{
            id: string;
            properties: Record<string, unknown>;
            point: [number, number] | null;
            bbox: [number, number, number, number] | null;
          }>;
        };
        return body.results.map((row): SearchResult => {
          const props = row.properties ?? {};
          const label = layer.search!.labelTemplate
            ? renderTemplate(layer.search!.labelTemplate, props)
            : firstNonEmpty(fields.map((ff) => props[ff])) ?? '(unnamed)';
          // The canvas highlight does a best-effort property match, so
          // carry the attrs on a minimal feature. Geometry is null when
          // the layer has none (table layer); the fly-to uses bbox /
          // center directly, not this feature's geometry.
          const feature: GeoJSON.Feature = {
            type: 'Feature',
            properties: props,
            // An empty GeometryCollection stands in when the layer has
            // no geometry (table layer): the highlight matches on
            // properties and the fly-to uses bbox / center, so the
            // feature geometry is never read for v3 hits. GeoJSON.Feature
            // requires a non-null geometry, hence the empty collection
            // rather than null.
            geometry: row.point
              ? { type: 'Point', coordinates: row.point }
              : { type: 'GeometryCollection', geometries: [] },
          };
          return {
            kind: 'feature',
            layerId: layer.id,
            layerTitle: layer.title,
            label,
            subtitle:
              fields
                .map((ff) => {
                  const val = props[ff];
                  return val ? `${ff}: ${val}` : null;
                })
                .filter(Boolean)
                .join(' · ') || null,
            bbox: row.bbox,
            center: row.point,
            feature,
          };
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          return [] as SearchResult[];
        }
        // eslint-disable-next-line no-console
        console.warn(`[search] ${layer.title}:`, (err as Error).message);
        return [] as SearchResult[];
      }
    });

  const perLayer = await Promise.all(tasks);
  return perLayer.flat();
}

/**
 * Ask a portal-hosted geocoding_service item (#74) for candidates.
 * Same shape as `geocode()`: returns `kind: 'place'` results with
 * label + center coordinates. The runtime hits
 * /api/portal/geocode/:itemId which enforces authz (the viewer
 * must be able to read the geocoder item AND the underlying
 * data_layer). When the user lacks access, this returns an empty
 * list rather than throwing -- the search bar then surfaces "no
 * candidates" the same way it would for an empty Nominatim result.
 *
 * The map's visible-extent bbox is forwarded so the runtime clamps
 * its similarity scan to the user's current view; large statewide
 * geocoders stay fast even when zoomed in.
 */
export async function geocodeViaItem(
  query: string,
  geocoderItemId: string,
  bbox: [number, number, number, number] | null,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const params = new URLSearchParams({ text: q });
  if (bbox) params.set('bbox', bbox.join(','));
  params.set('limit', '8');
  const url = `/api/portal/geocode/${encodeURIComponent(geocoderItemId)}?${params.toString()}`;
  const init: RequestInit = { headers: { Accept: 'application/json' } };
  if (signal) init.signal = signal;
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return [];
    return [];
  }
  if (!res.ok) return [];
  const body = (await res.json()) as {
    candidates: Array<{
      featureId: string;
      score: number;
      label: string;
      geom: { type: 'Point'; coordinates: [number, number] };
    }>;
  };
  return body.candidates.map((c) => {
    const [lng, lat] = c.geom.coordinates;
    return {
      kind: 'place' as const,
      label: c.label,
      // Score-as-subtitle keeps the geocoder's ranking visible to
      // the user without an extra column; mirrors what Esri's
      // Locator picker shows on hover.
      subtitle: `score ${c.score.toFixed(2)}`,
      bbox: null,
      center: Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null,
    };
  });
}

/**
 * Thrown when the geocoder could not be asked, as opposed to being
 * asked and having nothing to say.
 *
 * Those two were indistinguishable: a transport failure, a non-2xx,
 * and a genuine zero-result response all collapsed to an empty array,
 * so a Nominatim container that was down, unreachable, or holding an
 * OSM extract that does not cover the area in question looked exactly
 * like "there is no such place". The proxy at /api/geocode already
 * separates them, returning 502 with a message for an upstream error
 * and 502 "Geocoder unreachable" for a fetch failure; the client was
 * throwing that distinction away.
 */
export class GeocoderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeocoderUnavailableError';
  }
}

/**
 * Ask Nominatim for matches. The abort signal cancels stale requests
 * so the UI never applies a result that's already been superseded.
 *
 * Returns [] only for "asked, nothing matched". Throws
 * GeocoderUnavailableError when the question could not be put.
 */
export async function geocode(
  query: string,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  const url = `${GEOCODE_URL}?q=${encodeURIComponent(q)}`;
  const init: RequestInit = { headers: { Accept: 'application/json' } };
  if (signal) init.signal = signal;

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // An abort is the caller superseding its own request, not a
    // failure, and must stay silent.
    if (err instanceof Error && err.name === 'AbortError') return [];
    throw new GeocoderUnavailableError(
      err instanceof Error ? err.message : String(err),
    );
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { message?: unknown };
      if (typeof body.message === 'string' && body.message) detail = body.message;
    } catch {
      /* non-JSON error body; the status is all we have */
    }
    throw new GeocoderUnavailableError(detail);
  }
  const rows = (await res.json()) as Array<{
    display_name: string;
    lat: string;
    lon: string;
    boundingbox?: [string, string, string, string];
    type?: string;
    class?: string;
  }>;
  return rows.map((row) => {
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    const bb = row.boundingbox;
    const bbox =
      bb && bb.length === 4
        ? ([Number(bb[2]), Number(bb[0]), Number(bb[3]), Number(bb[1])] as [
            number,
            number,
            number,
            number,
          ])
        : null;
    return {
      kind: 'place' as const,
      label: row.display_name,
      subtitle: row.class
        ? `${row.class}${row.type ? ` · ${row.type}` : ''}`
        : null,
      bbox,
      center: Number.isFinite(lat) && Number.isFinite(lon) ? [lon, lat] : null,
    };
  });
}

function featureBbox(
  f: GeoJSON.Feature,
): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let seen = false;
  function visit(v: unknown) {
    if (Array.isArray(v)) {
      if (v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number') {
        const x = v[0] as number;
        const y = v[1] as number;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        seen = true;
      } else {
        for (const c of v) visit(c);
      }
    }
  }
  const geom = f.geometry;
  if (!geom) return null;
  if ('coordinates' in geom) visit(geom.coordinates);
  else if (geom.type === 'GeometryCollection') {
    for (const g of geom.geometries) {
      if ('coordinates' in g) visit(g.coordinates);
    }
  }
  return seen ? [minX, minY, maxX, maxY] : null;
}

function featureCenter(f: GeoJSON.Feature): [number, number] | null {
  const geom = f.geometry;
  if (!geom) return null;
  if (geom.type === 'Point') {
    const c = geom.coordinates as number[];
    return c.length >= 2 ? [c[0]!, c[1]!] : null;
  }
  const bb = featureBbox(f);
  if (!bb) return null;
  return [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
}

function firstNonEmpty(vs: unknown[]): string | null {
  for (const v of vs) {
    if (v !== null && v !== undefined && String(v).length > 0) return String(v);
  }
  return null;
}

function renderTemplate(
  template: string,
  props: Record<string, unknown>,
): string {
  return template.replace(
    /\{\{\s*([\w.-]+)\s*(?:\|\s*([\w.-]+))?\s*\}\}/g,
    (_, key: string, formatter?: string) => {
      const raw = props[key];
      if (raw === undefined || raw === null) return '';
      const str = String(raw);
      switch (formatter?.toLowerCase()) {
        case 'upper':
          return str.toUpperCase();
        case 'lower':
          return str.toLowerCase();
        case 'number': {
          const n = Number(str);
          return Number.isNaN(n) ? str : n.toLocaleString();
        }
        default:
          return str;
      }
    },
  );
}
