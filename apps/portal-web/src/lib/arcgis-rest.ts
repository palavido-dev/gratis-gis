/**
 * Thin client for ArcGIS REST Map / Feature services.
 *
 * Two responsibilities today:
 *   1. Probe a service URL to discover whether it's a MapServer or
 *      FeatureServer and list its sublayers so the Add Layer dialog
 *      can show a picker.
 *   2. Fetch features for a given bbox + layer id as GeoJSON, with
 *      `exceededTransferLimit` pagination so we aren't silently
 *      capped at the server's per-request max record count.
 *
 * Kept deliberately small: no dependency on the portal-api backend,
 * no Esri JSON↔GeoJSON conversion. Modern ArcGIS Server (10.8+)
 * speaks `f=geojson` natively; older servers that only emit Esri JSON
 * will need a conversion shim, which we can add the first time
 * someone hits one in the wild. The code below detects the omission
 * and surfaces a clear error rather than silently rendering nothing.
 */
export type ArcgisServiceType = 'MapServer' | 'FeatureServer';

export interface ArcgisServiceDescription {
  url: string;
  serviceType: ArcgisServiceType;
  name: string;
  description?: string;
  layers: ArcgisServiceLayer[];
  /** Service-level spatial extent (lng/lat) if the server reported one. */
  bbox: [number, number, number, number] | null;
}

export interface ArcgisServiceLayer {
  id: number;
  name: string;
  geometryType?: string;
  minScale?: number;
  maxScale?: number;
  /** Parent group layer id when the server uses nested layers. */
  parentLayerId?: number;
}

/**
 * Hit the service root and normalize the response. Accepts either the
 * bare service URL (…/MapServer) or a layer URL (…/MapServer/0); in
 * the layer form we strip the trailing segment so the caller gets the
 * full layer list back.
 */
export async function probeService(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<ArcgisServiceDescription> {
  const { serviceUrl, layerId } = splitServiceUrl(rawUrl);
  const serviceType = detectServiceType(serviceUrl);
  const json = await fetchJson(
    appendQuery(serviceUrl, { f: 'json' }),
    signal,
  );

  const layers: ArcgisServiceLayer[] = [];
  if (Array.isArray(json.layers)) {
    for (const l of json.layers) {
      layers.push({
        id: Number(l.id),
        name: String(l.name ?? `Layer ${l.id}`),
        geometryType: l.geometryType,
        minScale: l.minScale,
        maxScale: l.maxScale,
        parentLayerId: l.parentLayerId,
      });
    }
  }
  // FeatureServers expose tables separately; surface those too so the
  // picker shows them (user can pick an attribute-only "layer": we'll
  // still render an empty map but the table view works).
  if (Array.isArray(json.tables)) {
    for (const t of json.tables) {
      layers.push({
        id: Number(t.id),
        name: `${t.name ?? `Table ${t.id}`} (table)`,
      });
    }
  }

  const bbox = extentToBbox(json.fullExtent ?? json.initialExtent);

  // If the caller passed …/0, bubble that up as the "picked" layer so
  // the dialog can pre-select the right row in the picker.
  if (layerId != null && !layers.some((l) => l.id === layerId)) {
    // Layer wasn't in the service summary: probe the layer directly
    // so we at least have a display name.
    try {
      const lj = await fetchJson(
        appendQuery(`${serviceUrl}/${layerId}`, { f: 'json' }),
        signal,
      );
      layers.push({
        id: layerId,
        name: String(lj.name ?? `Layer ${layerId}`),
        geometryType: lj.geometryType,
        minScale: lj.minScale,
        maxScale: lj.maxScale,
      });
    } catch {
      /* non-fatal */
    }
  }

  return {
    url: serviceUrl,
    serviceType,
    name: String(json.mapName ?? json.serviceDescription ?? inferName(serviceUrl)),
    description: typeof json.description === 'string' ? json.description : undefined,
    layers,
    bbox,
  };
}

/**
 * Fetch features inside a bounding box as a GeoJSON FeatureCollection.
 * Respects the server's `maxRecordCount` by walking `resultOffset`
 * until `exceededTransferLimit` is false (or we hit `hardCap`).
 *
 * The returned collection is already in WGS84 (outSR=4326): the
 * geojson output format implies it but we pass it explicitly so
 * servers that honor both don't pick a local CRS.
 */
export async function fetchLayerBBox(
  url: string,
  layerId: number,
  bbox: [number, number, number, number],
  opts: { signal?: AbortSignal; hardCap?: number; pageSize?: number } = {},
): Promise<{
  featureCollection: GeoJSON.FeatureCollection;
  exceededHardCap: boolean;
}> {
  const hardCap = opts.hardCap ?? 5000;
  const pageSize = opts.pageSize ?? 2000;
  const features: GeoJSON.Feature[] = [];
  let offset = 0;
  let exceededHardCap = false;

  while (features.length < hardCap) {
    const page = await fetchBBoxPage(
      url,
      layerId,
      bbox,
      offset,
      pageSize,
      opts.signal,
    );
    if (page.features.length === 0) break;
    features.push(...page.features);
    if (!page.exceededTransferLimit) break;
    offset += page.features.length;
    if (features.length >= hardCap) {
      exceededHardCap = true;
      break;
    }
  }
  return {
    featureCollection: { type: 'FeatureCollection', features },
    exceededHardCap,
  };
}

// --- internals ----------------------------------------------------------

async function fetchBBoxPage(
  url: string,
  layerId: number,
  bbox: [number, number, number, number],
  offset: number,
  pageSize: number,
  signal: AbortSignal | undefined,
): Promise<{
  features: GeoJSON.Feature[];
  exceededTransferLimit: boolean;
}> {
  const queryUrl = appendQuery(`${url}/${layerId}/query`, {
    where: '1=1',
    geometry: `${bbox[0]},${bbox[1]},${bbox[2]},${bbox[3]}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    outSR: '4326',
    f: 'geojson',
    resultOffset: String(offset),
    resultRecordCount: String(pageSize),
  });
  const json = await fetchJson(queryUrl, signal);
  if (json?.type !== 'FeatureCollection') {
    throw new Error(
      'ArcGIS server did not return GeoJSON. If this is an older ' +
        'service (pre-10.8) it may only speak Esri JSON: we need a ' +
        'server-side conversion shim for that case.',
    );
  }
  return {
    features: Array.isArray(json.features) ? (json.features as GeoJSON.Feature[]) : [],
    exceededTransferLimit: json.exceededTransferLimit === true,
  };
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<any> {
  const init: RequestInit = signal ? { signal } : {};
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`ArcGIS request failed: ${res.status} ${res.statusText}`);
  }
  const j = await res.json();
  if (j && j.error) {
    const e = j.error;
    throw new Error(
      `ArcGIS error ${e.code ?? ''}: ${e.message ?? 'unknown'}`.trim(),
    );
  }
  return j;
}

function splitServiceUrl(raw: string): {
  serviceUrl: string;
  layerId: number | null;
} {
  const trimmed = raw.replace(/\/$/, '');
  // Matches ".../MapServer/0" or ".../FeatureServer/12" with optional
  // query string: captures the numeric layer id as the last segment.
  const m = trimmed.match(
    /^(.*\/(?:MapServer|FeatureServer))\/(\d+)(?:\?.*)?$/i,
  );
  if (m) {
    return { serviceUrl: m[1]!, layerId: Number(m[2]) };
  }
  return { serviceUrl: trimmed, layerId: null };
}

function detectServiceType(url: string): ArcgisServiceType {
  if (/\/FeatureServer\b/i.test(url)) return 'FeatureServer';
  return 'MapServer';
}

function appendQuery(url: string, params: Record<string, string>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.set(k, v);
  }
  return u.toString();
}

function extentToBbox(
  extent: unknown,
): [number, number, number, number] | null {
  if (!extent || typeof extent !== 'object') return null;
  const e = extent as Record<string, unknown>;
  const xmin = Number(e.xmin);
  const ymin = Number(e.ymin);
  const xmax = Number(e.xmax);
  const ymax = Number(e.ymax);
  if (
    !Number.isFinite(xmin) ||
    !Number.isFinite(ymin) ||
    !Number.isFinite(xmax) ||
    !Number.isFinite(ymax)
  ) {
    return null;
  }
  // Only return the bbox when the spatial reference is WGS84. ArcGIS
  // servers commonly emit Web Mercator extents (wkid 3857/102100);
  // rather than reproject in the browser, we drop the extent in that
  // case: the layer will still render once the user zooms to it.
  const sr = (e.spatialReference as { wkid?: number } | undefined)?.wkid;
  if (sr && sr !== 4326) return null;
  return [xmin, ymin, xmax, ymax];
}

function inferName(serviceUrl: string): string {
  const parts = serviceUrl.split('/').filter(Boolean);
  // …/services/<folder>/<name>/MapServer  →  name
  const idx = parts.lastIndexOf('MapServer') || parts.lastIndexOf('FeatureServer');
  if (idx > 0) return parts[idx - 1] ?? 'ArcGIS layer';
  return 'ArcGIS layer';
}
