// SPDX-License-Identifier: AGPL-3.0-or-later
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
export type ArcgisServiceType =
  | 'MapServer'
  | 'FeatureServer'
  | 'GeocodeServer';

export interface ArcgisServiceDescription {
  url: string;
  serviceType: ArcgisServiceType;
  name: string;
  description?: string;
  layers: ArcgisServiceLayer[];
  /** Service-level spatial extent (lng/lat) if the server reported one. */
  bbox: [number, number, number, number] | null;
  /** GeocodeServer (#75): multi-line address input shape lifted from
   *  the server's `addressFields[]`. Empty array for non-geocoders. */
  geocodeAddressFields?: Array<{
    name: string;
    alias?: string;
    required?: boolean;
  }>;
  /** GeocodeServer (#75): name of the single-line address field, when
   *  the server advertises one. */
  geocodeSingleLineField?: string;
  /** GeocodeServer (#75): ISO-style country codes the locator
   *  indexes, when the server advertises a country list. */
  geocodeCountries?: string[];
  /** GeocodeServer (#75): lowercased capability tokens lifted from
   *  the server's comma-separated `capabilities` string. */
  geocodeCapabilities?: string[];
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
  const { serviceUrl } = splitServiceUrl(rawUrl);
  const json = await fetchJson(
    appendQuery(serviceUrl, { f: 'json' }),
    signal,
  );
  return describeArcgisService(rawUrl, json, signal);
}

/**
 * Pure ArcGIS-JSON ⇒ ArcgisServiceDescription parser, split out of
 * probeService (#74) so callers that already have the JSON in hand
 * (e.g. the wizard's credentialed-probe path that goes through the
 * server-side proxy) can reuse the same shaping logic. Doing the
 * (rare) "user pasted /MapServer/0" follow-up fetch is optional;
 * pass an AbortSignal if the caller wants to keep cancellation
 * working through it.
 */
export async function describeArcgisService(
  rawUrl: string,
  json: unknown,
  signal?: AbortSignal,
): Promise<ArcgisServiceDescription> {
  const { serviceUrl, layerId } = splitServiceUrl(rawUrl);
  const serviceType = detectServiceType(serviceUrl);
  const obj = (json ?? {}) as {
    layers?: unknown;
    tables?: unknown;
    fullExtent?: unknown;
    initialExtent?: unknown;
    mapName?: unknown;
    serviceDescription?: unknown;
    description?: unknown;
    // GeocodeServer-only fields. ArcGIS GeocodeServer responses
    // carry these instead of a `layers` array; describeArcgisService
    // returns them on the description so the service-probe pipeline
    // can route to the arcgis_geocode protocol.
    addressFields?: unknown;
    singleLineAddressField?: unknown;
    countries?: unknown;
    capabilities?: unknown;
  };

  const layers: ArcgisServiceLayer[] = [];
  if (Array.isArray(obj.layers)) {
    for (const l of obj.layers as Array<Record<string, unknown>>) {
      const row: ArcgisServiceLayer = {
        id: Number(l.id),
        name: String(l.name ?? `Layer ${l.id}`),
      };
      if (typeof l.geometryType === 'string') row.geometryType = l.geometryType;
      if (typeof l.minScale === 'number') row.minScale = l.minScale;
      if (typeof l.maxScale === 'number') row.maxScale = l.maxScale;
      if (typeof l.parentLayerId === 'number')
        row.parentLayerId = l.parentLayerId;
      layers.push(row);
    }
  }
  if (Array.isArray(obj.tables)) {
    for (const t of obj.tables as Array<Record<string, unknown>>) {
      layers.push({
        id: Number(t.id),
        name: `${t.name ?? `Table ${t.id}`} (table)`,
      });
    }
  }

  const bbox = extentToBbox(obj.fullExtent ?? obj.initialExtent);

  if (layerId != null && !layers.some((l) => l.id === layerId)) {
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

  const out: ArcgisServiceDescription = {
    url: serviceUrl,
    serviceType,
    name: serviceName(obj, serviceUrl),
    layers,
    bbox,
  };
  if (typeof obj.description === 'string') {
    out.description = obj.description;
  }

  // GeocodeServer-specific metadata (#75). Only meaningful when the
  // URL ended in /GeocodeServer; for MapServer/FeatureServer these
  // keys are absent in the response and the helpers below return
  // undefined or empty.
  if (serviceType === 'GeocodeServer') {
    const addressFields = parseGeocodeAddressFields(obj.addressFields);
    if (addressFields && addressFields.length > 0) {
      out.geocodeAddressFields = addressFields;
    }
    const singleLine = parseGeocodeSingleLineField(obj.singleLineAddressField);
    if (singleLine) out.geocodeSingleLineField = singleLine;
    const countries = parseGeocodeCountries(obj.countries);
    if (countries && countries.length > 0) out.geocodeCountries = countries;
    const capabilities = parseGeocodeCapabilities(obj.capabilities);
    if (capabilities && capabilities.length > 0) {
      out.geocodeCapabilities = capabilities;
    }
  }
  return out;
}

/**
 * Parse a GeocodeServer `addressFields[]` array. ArcGIS publishes
 * each field as an object with `name`, `alias`, `required`, plus
 * various format details we ignore (length, type, recognizedNames).
 * Returns undefined if the input isn't a recognizable array shape
 * so the caller's optional-field assignment is clean.
 */
function parseGeocodeAddressFields(
  input: unknown,
): Array<{ name: string; alias?: string; required?: boolean }> | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: Array<{ name: string; alias?: string; required?: boolean }> = [];
  for (const f of input) {
    if (!f || typeof f !== 'object') continue;
    const row = f as { name?: unknown; alias?: unknown; required?: unknown };
    if (typeof row.name !== 'string' || row.name.length === 0) continue;
    const entry: { name: string; alias?: string; required?: boolean } = {
      name: row.name,
    };
    if (typeof row.alias === 'string' && row.alias.length > 0) {
      entry.alias = row.alias;
    }
    if (typeof row.required === 'boolean') entry.required = row.required;
    out.push(entry);
  }
  return out;
}

/**
 * Parse the GeocodeServer `singleLineAddressField` element. ArcGIS
 * publishes this as a sibling object (same shape as one addressField)
 * naming the field that accepts a single combined-address string.
 * We only carry the `name`; the input shape (and any picklist of
 * valid values) is the server's concern at request time.
 */
function parseGeocodeSingleLineField(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as { name?: unknown };
  return typeof obj.name === 'string' && obj.name.length > 0
    ? obj.name
    : undefined;
}

/**
 * Parse the GeocodeServer `countries` field. ArcGIS publishes this
 * as either an array of strings ("USA", "CAN") or a comma-separated
 * string ("USA,CAN"). Normalize to an array of uppercase ISO-style
 * codes, deduplicated.
 */
function parseGeocodeCountries(input: unknown): string[] | undefined {
  if (Array.isArray(input)) {
    const arr = input
      .filter((c): c is string => typeof c === 'string' && c.length > 0)
      .map((c) => c.trim().toUpperCase());
    return [...new Set(arr)];
  }
  if (typeof input === 'string' && input.length > 0) {
    const arr = input
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter((c) => c.length > 0);
    return [...new Set(arr)];
  }
  return undefined;
}

/**
 * Parse the GeocodeServer `capabilities` string. ArcGIS publishes
 * this as a comma-separated string like "Geocode,ReverseGeocode,Suggest".
 * Normalize to lowercase tokens so downstream feature gates can
 * pattern-match without case juggling.
 */
function parseGeocodeCapabilities(input: unknown): string[] | undefined {
  if (typeof input !== 'string' || input.length === 0) return undefined;
  const toks = input
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  return toks.length > 0 ? [...new Set(toks)] : undefined;
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
    exceededTransferLimit: exceededTransferLimit(json),
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
  if (/\/GeocodeServer\b/i.test(url)) return 'GeocodeServer';
  return 'MapServer';
}

function appendQuery(url: string, params: Record<string, string>): string {
  // Support relative URLs (e.g. our `/api/portal/items/.../proxy`
  // for secured services). `new URL(url)` throws for paths without
  // a scheme, so pass window.location.origin as the base when we're
  // in the browser. Falls back to a synthetic base on the server
  // side; we only ever need toString() to round-trip the query
  // string and the relative-path portion is preserved either way.
  const isAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(url);
  const base = isAbsolute
    ? undefined
    : typeof window !== 'undefined'
      ? window.location.origin
      : 'http://localhost';
  const u = new URL(url, base);
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.set(k, v);
  }
  // For relative URLs, return just the path + search so the caller
  // can keep using a relative URL (the BFF route is on the same
  // origin and we don't want to hard-code it).
  if (!isAbsolute) return `${u.pathname}${u.search}`;
  return u.toString();
}

export function extentToBbox(
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
  //
  // A spatial reference with no wkid (only `wkt`, as custom and some
  // state plane services send, or none at all) used to pass as WGS84,
  // so projected metres came back as a lng/lat bbox. With a wkid or
  // latestWkid, it must be 4326. Without either, accept the extent
  // only when it actually fits in lng/lat range.
  const sr = e.spatialReference as
    | { wkid?: unknown; latestWkid?: unknown }
    | undefined;
  const wkid = Number(sr?.wkid);
  const latest = Number(sr?.latestWkid);
  const hasWkid = Number.isFinite(wkid) && wkid > 0;
  const hasLatest = Number.isFinite(latest) && latest > 0;
  if (hasWkid || hasLatest) {
    if (wkid !== 4326 && latest !== 4326) return null;
  } else if (
    xmin < -180 || xmax > 180 || ymin < -90 || ymax > 90
  ) {
    return null;
  }
  return [xmin, ymin, xmax, ymax];
}

/**
 * The paging flag from a `f=geojson` query. ArcGIS Online and recent
 * ArcGIS Server put it under `properties` on the FeatureCollection,
 * older servers at the top level. Reading only the top level stopped
 * the loop after the first page on the newer ones.
 */
export function exceededTransferLimit(json: unknown): boolean {
  if (!json || typeof json !== 'object') return false;
  const j = json as {
    exceededTransferLimit?: unknown;
    properties?: { exceededTransferLimit?: unknown } | null;
  };
  return (
    j.exceededTransferLimit === true ||
    j.properties?.exceededTransferLimit === true
  );
}

/**
 * Display name for a service: `mapName` when the server sends one,
 * else the service's own name from the URL. `serviceDescription` is a
 * long free text description and FeatureServers usually send it as an
 * empty string, so it is only a last resort, and only when non-empty.
 */
export function serviceName(
  obj: { mapName?: unknown; serviceDescription?: unknown },
  serviceUrl: string,
): string {
  const nonEmpty = (v: unknown): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
  return (
    nonEmpty(obj.mapName) ??
    inferName(serviceUrl) ??
    nonEmpty(obj.serviceDescription) ??
    'ArcGIS layer'
  );
}

function inferName(serviceUrl: string): string | null {
  const parts = serviceUrl.split('/').filter(Boolean);
  // …/services/<folder>/<name>/MapServer  →  name
  // lastIndexOf answers -1 when absent, and -1 is truthy, so `a || b`
  // never looked for FeatureServer. Take the last of any of them.
  const idx = Math.max(
    parts.lastIndexOf('MapServer'),
    parts.lastIndexOf('FeatureServer'),
    parts.lastIndexOf('GeocodeServer'),
  );
  if (idx > 0) return parts[idx - 1] ?? null;
  return null;
}
