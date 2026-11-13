// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Thin client for WMS / WFS GetCapabilities probe (#297).
 *
 * Both protocols share the same shape: hit `<base>?service=<X>
 * &request=GetCapabilities`, parse the XML response, return the
 * list of layers / feature types so the wizard can show a picker.
 *
 * No portal-api involvement: the browser talks to the remote server
 * directly. CORS-blocked services need a portal proxy (#97) which is
 * separate work; on a CORS failure we surface a clear error.
 *
 * Like arcgis-rest, no dependency on a heavier XML lib -- the
 * browser's DOMParser handles GetCapabilities responses fine for
 * WMS 1.1.1 / 1.3.0 and WFS 1.1.0 / 2.0.0.
 */

export type OgcServiceKind = 'wms' | 'wfs';

export interface OgcLayerSnapshot {
  /** WMS Name / WFS typeName -- the id MapLibre + WFS GetFeature will
   *  reference. */
  name: string;
  /** Human-friendly Title. Falls back to name when absent. */
  title: string;
  /** Bounding box (lng/lat) when the server reports one. */
  bbox?: [number, number, number, number];
}

export interface WmsCapabilities {
  kind: 'wms';
  /** Service base URL: what the user provided, minus the OGC request
   *  parameters. Vendor parameters such as `map=` stay on it. */
  url: string;
  /** WMS protocol version reported by the server. */
  protocolVersion: '1.1.1' | '1.3.0';
  /** Server-advertised service title for the wizard summary. */
  title?: string;
  layers: OgcLayerSnapshot[];
  /** Service-level spatial extent if any layer's bbox can be unioned. */
  bbox: [number, number, number, number] | null;
}

export interface WfsCapabilities {
  kind: 'wfs';
  url: string;
  protocolVersion: '1.1.0' | '2.0.0';
  title?: string;
  layers: OgcLayerSnapshot[];
  bbox: [number, number, number, number] | null;
}

export type OgcCapabilities = WmsCapabilities | WfsCapabilities;

/**
 * Query keys the OGC request owns. Everything else on a pasted URL is
 * the server's own (MapServer's `map=`, a vendor `key=` or token) and
 * has to travel with every request, or the server cannot answer.
 */
const OGC_REQUEST_KEYS = new Set(['service', 'request', 'version', 'acceptversions']);

function splitQuery(raw: string): { path: string; parts: string[] } {
  const noHash = raw.split('#')[0] ?? '';
  const idx = noHash.indexOf('?');
  if (idx < 0) return { path: noHash, parts: [] };
  return {
    path: noHash.slice(0, idx),
    parts: noHash.slice(idx + 1).split('&').filter((p) => p.length > 0),
  };
}

function queryKey(part: string): string {
  const key = part.split('=')[0] ?? '';
  try {
    return decodeURIComponent(key).toLowerCase();
  } catch {
    return key.toLowerCase();
  }
}

/**
 * Normalize the user-supplied URL into the base every OGC request is
 * built on: trailing slash dropped, the OGC request keys (service,
 * request, version) removed, and any other query parameter kept as
 * it was typed.
 */
export function ogcBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Service URL is required.');
  const { path, parts } = splitQuery(trimmed);
  const base = path.replace(/(?<!\/)\/+$/, '');
  const kept = parts.filter((p) => !OGC_REQUEST_KEYS.has(queryKey(p)));
  return kept.length > 0 ? `${base}?${kept.join('&')}` : base;
}

/** Append OGC request parameters to a base from ogcBaseUrl, after
 *  whatever vendor parameters it already carries. */
export function ogcRequestUrl(base: string, params: Record<string, string>): string {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `${base}${base.includes('?') ? '&' : '?'}${qs}`;
}

/** Probe a WMS endpoint. Returns the layer list + service metadata. */
export async function probeWms(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<WmsCapabilities> {
  const base = ogcBaseUrl(rawUrl);
  // Prefer 1.3.0 (current); fall back to 1.1.1 if the server objects.
  // Many older deployments only speak 1.1.1 and ignore version=1.3.0
  // by returning their default; the parser tolerates either.
  const url = ogcRequestUrl(base, {
    service: 'WMS',
    request: 'GetCapabilities',
    version: '1.3.0',
  });
  const xml = await fetchXml(url, signal);
  return parseWmsCapabilities(base, xml);
}

/** Probe a WFS endpoint. Returns the feature-type list. */
export async function probeWfs(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<WfsCapabilities> {
  const base = ogcBaseUrl(rawUrl);
  // Prefer 2.0.0 -- it's the OGC standard since 2010 and widely
  // supported. Servers stuck on 1.1.0 still return parseable XML.
  const url = ogcRequestUrl(base, {
    service: 'WFS',
    request: 'GetCapabilities',
    version: '2.0.0',
  });
  const xml = await fetchXml(url, signal);
  return parseWfsCapabilities(base, xml);
}

async function fetchXml(url: string, signal?: AbortSignal): Promise<Document> {
  let res: Response;
  try {
    res = await fetch(url, {
      signal: signal ?? null,
      headers: { Accept: 'application/xml, text/xml, */*' },
    });
  } catch (err) {
    // CORS preflight failures land here as a generic TypeError. Surface
    // a clearer message so the user knows the fix is a server-side
    // CORS header (or our own proxy in #97), not a typo'd URL.
    throw new Error(
      err instanceof Error
        ? `Could not reach service (likely CORS or unreachable host): ${err.message}`
        : 'Could not reach service.',
    );
  }
  if (!res.ok) {
    throw new Error(`GetCapabilities returned ${res.status}.`);
  }
  const text = await res.text();
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('Service returned non-XML or malformed XML.');
  }
  return doc;
}

function parseWmsCapabilities(baseUrl: string, doc: Document): WmsCapabilities {
  // WMS 1.3.0 root element is <WMS_Capabilities>; 1.1.1 root is
  // <WMT_MS_Capabilities>. Use either to pick the version, then parse
  // layer entries (also recursive, since WMS allows nested groups).
  const root = doc.documentElement;
  const versionAttr = root.getAttribute('version') ?? '1.3.0';
  const protocolVersion: '1.1.1' | '1.3.0' = versionAttr.startsWith('1.1')
    ? '1.1.1'
    : '1.3.0';
  const title = textOf(root.querySelector('Service > Title'));
  const layers: OgcLayerSnapshot[] = [];
  const allBboxes: Array<[number, number, number, number]> = [];

  // WMS lists capability layers under Capability/Layer; the top-level
  // Layer is often a wrapper with no Name (it's the service-wide group)
  // and contains real named child layers. Walk recursively, only emit
  // layers that have a Name (Name-less layers are presentational
  // groups in WMS, not addressable in GetMap).
  function walk(el: Element) {
    const tag = el.tagName.toLowerCase();
    if (tag !== 'layer') {
      for (const child of Array.from(el.children)) walk(child);
      return;
    }
    const name = textOf(directChild(el, 'Name'));
    const layerTitle = textOf(directChild(el, 'Title'));
    const bbox = parseWmsBbox(el, protocolVersion);
    if (name) {
      const snap: OgcLayerSnapshot = {
        name,
        title: layerTitle || name,
      };
      if (bbox) snap.bbox = bbox;
      layers.push(snap);
      if (bbox) allBboxes.push(bbox);
    }
    for (const child of Array.from(el.children)) walk(child);
  }
  walk(root);

  const out: WmsCapabilities = {
    kind: 'wms',
    url: baseUrl,
    protocolVersion,
    layers,
    bbox: unionBboxes(allBboxes),
  };
  if (title) out.title = title;
  return out;
}

function parseWfsCapabilities(baseUrl: string, doc: Document): WfsCapabilities {
  const root = doc.documentElement;
  const versionAttr = root.getAttribute('version') ?? '2.0.0';
  const protocolVersion: '1.1.0' | '2.0.0' = versionAttr.startsWith('1.1')
    ? '1.1.0'
    : '2.0.0';
  const title = textOf(
    root.querySelector('ServiceIdentification > Title') ??
      root.querySelector('Service > Title'),
  );

  const layers: OgcLayerSnapshot[] = [];
  const allBboxes: Array<[number, number, number, number]> = [];

  // WFS lists feature types under FeatureTypeList/FeatureType; both
  // 1.1.0 and 2.0.0 use the same element names. Each FeatureType has a
  // Name (NamespaceURI:LocalPart or just LocalPart), Title, and a
  // WGS84 bbox via WGS84BoundingBox (2.0.0) or LatLongBoundingBox
  // (1.1.0).
  const featureTypes = doc.getElementsByTagName('FeatureType');
  for (const ft of Array.from(featureTypes)) {
    const name = textOf(directChild(ft, 'Name'));
    const ftTitle = textOf(directChild(ft, 'Title'));
    const bbox = parseWfsBbox(ft);
    if (!name) continue;
    const snap: OgcLayerSnapshot = {
      name,
      title: ftTitle || name,
    };
    if (bbox) snap.bbox = bbox;
    layers.push(snap);
    if (bbox) allBboxes.push(bbox);
  }

  const out: WfsCapabilities = {
    kind: 'wfs',
    url: baseUrl,
    protocolVersion,
    layers,
    bbox: unionBboxes(allBboxes),
  };
  if (title) out.title = title;
  return out;
}

/** Read a WMS layer's bbox. EX_GeographicBoundingBox is the 1.3.0
 *  version; LatLonBoundingBox is the 1.1.1 fallback. Both report
 *  WGS84 lng/lat which is what we want for the item summary. */
function parseWmsBbox(
  el: Element,
  version: '1.1.1' | '1.3.0',
): [number, number, number, number] | undefined {
  if (version === '1.3.0') {
    const ex = directChild(el, 'EX_GeographicBoundingBox');
    if (ex) {
      const w = numberFrom(ex.getElementsByTagName('westBoundLongitude')[0]);
      const e = numberFrom(ex.getElementsByTagName('eastBoundLongitude')[0]);
      const s = numberFrom(ex.getElementsByTagName('southBoundLatitude')[0]);
      const n = numberFrom(ex.getElementsByTagName('northBoundLatitude')[0]);
      if ([w, e, s, n].every((v) => Number.isFinite(v))) {
        return [w, s, e, n];
      }
    }
  }
  const ll = directChild(el, 'LatLonBoundingBox');
  if (ll) {
    const minx = Number(ll.getAttribute('minx'));
    const miny = Number(ll.getAttribute('miny'));
    const maxx = Number(ll.getAttribute('maxx'));
    const maxy = Number(ll.getAttribute('maxy'));
    if ([minx, miny, maxx, maxy].every(Number.isFinite)) {
      return [minx, miny, maxx, maxy];
    }
  }
  return undefined;
}

/** Read a WFS feature type's bbox. WGS84BoundingBox (2.0.0, OWS) or
 *  LatLongBoundingBox (1.1.0). Coordinates are space-separated lng lat
 *  pairs in <LowerCorner>/<UpperCorner>. */
function parseWfsBbox(
  ft: Element,
): [number, number, number, number] | undefined {
  const bbox =
    ft.getElementsByTagName('WGS84BoundingBox')[0] ??
    ft.getElementsByTagName('ows:WGS84BoundingBox')[0];
  if (bbox) {
    const lower = bbox.getElementsByTagName('LowerCorner')[0]?.textContent ?? '';
    const upper = bbox.getElementsByTagName('UpperCorner')[0]?.textContent ?? '';
    const lo = lower.trim().split(/\s+/).map(Number);
    const up = upper.trim().split(/\s+/).map(Number);
    if (lo.length === 2 && up.length === 2 && [...lo, ...up].every(Number.isFinite)) {
      return [lo[0]!, lo[1]!, up[0]!, up[1]!];
    }
  }
  const ll = ft.getElementsByTagName('LatLongBoundingBox')[0];
  if (ll) {
    const minx = Number(ll.getAttribute('minx'));
    const miny = Number(ll.getAttribute('miny'));
    const maxx = Number(ll.getAttribute('maxx'));
    const maxy = Number(ll.getAttribute('maxy'));
    if ([minx, miny, maxx, maxy].every(Number.isFinite)) {
      return [minx, miny, maxx, maxy];
    }
  }
  return undefined;
}

function unionBboxes(
  list: Array<[number, number, number, number]>,
): [number, number, number, number] | null {
  if (list.length === 0) return null;
  let [w, s, e, n] = list[0]!;
  for (let i = 1; i < list.length; i += 1) {
    const b = list[i]!;
    if (b[0] < w) w = b[0];
    if (b[1] < s) s = b[1];
    if (b[2] > e) e = b[2];
    if (b[3] > n) n = b[3];
  }
  return [w, s, e, n];
}

function directChild(parent: Element, tag: string): Element | null {
  // querySelector on namespaced XML is fiddly; iterate children to
  // pick the first matching local name. Handles "ns:Name" too.
  const lower = tag.toLowerCase();
  for (const child of Array.from(parent.children)) {
    const localName =
      child.localName ??
      child.tagName.replace(/^.*:/, '');
    if (localName.toLowerCase() === lower) return child;
  }
  return null;
}

function textOf(el: Element | null): string {
  return el?.textContent?.trim() ?? '';
}

function numberFrom(el: Element | undefined): number {
  if (!el || !el.textContent) return Number.NaN;
  return Number(el.textContent.trim());
}
