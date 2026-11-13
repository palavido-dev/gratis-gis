// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Auto-detect service probe (#304 slice 2).
 *
 * Given a URL pasted by an author, identify what kind of remote
 * spatial service it is and return a unified ServiceData payload the
 * wizard can stage and the runtime will later render. Replaces the
 * three separate probe entry points (arcgis-rest.probeService,
 * ogc-rest.probeWms, ogc-rest.probeWfs) at the wizard layer; those
 * libraries stay as the per-protocol implementation underneath.
 *
 * Detection strategy is "ask the URL what it is": ArcGIS REST has a
 * unique JSON shape, WMS / WFS / WMTS expose the same
 * GetCapabilities entry point but with different `service=`
 * parameters. We probe in this order, returning the first one that
 * responds:
 *
 *   1. ArcGIS REST (`?f=json` against the URL). Returns a `services`
 *      array (catalog) or a `currentVersion` field plus type-specific
 *      keys (`mapName`, `layers`, `serviceDescription`).
 *   2. WMS GetCapabilities. Existing probeWms() handles parsing.
 *   3. WFS GetCapabilities.
 *   4. WMTS GetCapabilities (1.0.0). Same pattern as WMS / WFS,
 *      different element names + tile-matrix metadata. Implemented
 *      inline below since ogc-rest.ts didn't ship WMTS.
 *
 * The order matters: ArcGIS first because its detection is the
 * cheapest (one JSON call, unambiguous shape); after that the OGC
 * trio share a base URL pattern so we ping each in parallel and
 * pick the first that returns valid capabilities XML for the
 * expected service.
 *
 * If everything fails the caller surfaces a clear "couldn't identify
 * the service" error and the wizard can let the user fall back to
 * a manual protocol picker.
 */
import {
  describeArcgisService,
  type ArcgisServiceDescription,
} from './arcgis-rest';
import {
  byLocalName,
  ogcBaseUrl,
  ogcRequestUrl,
  probeWms,
  probeWfs,
  type WmsCapabilities,
  type WfsCapabilities,
} from './ogc-rest';
import type {
  ISODateString,
  ServiceData,
  ServiceLayerSnapshot,
} from '@gratis-gis/shared-types';

/** What the wizard sees after a successful probe: the unified
 *  ServiceData ready to stage on the new item, plus a human-readable
 *  protocol label so the post-probe summary card can explain what
 *  was detected. */
export interface ServiceProbeResult {
  data: ServiceData;
  protocolLabel: string;
}

/**
 * Try to identify the service at `rawUrl` and return a ServiceData
 * payload. Throws when no known protocol responds; the caller wraps
 * the error and surfaces it in the wizard.
 */
export async function probeService(rawUrl: string): Promise<ServiceProbeResult> {
  const url = (rawUrl ?? '').trim();
  if (!url) {
    throw new Error('Service URL is required.');
  }
  const probedAt = new Date().toISOString() as ISODateString;

  // 1. ArcGIS REST first: cheapest detection.
  const arcgis = await tryArcgis(url).catch(() => null);
  if (arcgis) {
    return { data: arcgisToServiceData(arcgis, probedAt), protocolLabel: arcgis.serviceType };
  }

  // 2-4. OGC trio: try WMS, WFS, WMTS. Run in parallel since each
  // is a single GetCapabilities round-trip and we only commit to
  // whichever one responds with parseable capabilities for the
  // expected service. Promise.any returns the first fulfilled
  // result; if all reject we bail with a unified error.
  // A pasted GetCapabilities URL already says which service it is
  // (`?service=WFS&request=GetCapabilities`). The OGC keys are dropped
  // before probing, so read it first and try only that service;
  // otherwise whichever probe answered first won, often WMS.
  const asked = requestedOgcService(url);
  const ogcAttempts: Array<Promise<ServiceProbeResult>> = [];
  if (!asked || asked === 'WMS') {
    ogcAttempts.push(
      probeWms(url).then((c) => ({ data: wmsToServiceData(c, probedAt), protocolLabel: 'WMS' })),
    );
  }
  if (!asked || asked === 'WFS') {
    ogcAttempts.push(
      probeWfs(url).then((c) => ({ data: wfsToServiceData(c, probedAt), protocolLabel: 'WFS' })),
    );
  }
  if (!asked || asked === 'WMTS') {
    ogcAttempts.push(probeWmts(url).then((d) => ({ data: d, protocolLabel: 'WMTS' })));
  }
  try {
    const result = await Promise.any(ogcAttempts);
    return result;
  } catch {
    throw new Error(
      "Couldn't identify that URL as a known service (ArcGIS REST, WMS, WFS, or WMTS). Check the URL and that the server's GetCapabilities is reachable from this browser.",
    );
  }
}

/** The OGC service named by a `service=` parameter already in the
 *  pasted URL, if it is one we probe. */
export function requestedOgcService(rawUrl: string): 'WMS' | 'WFS' | 'WMTS' | null {
  const q = rawUrl.indexOf('?');
  if (q < 0) return null;
  const params = new URLSearchParams(rawUrl.slice(q + 1));
  for (const [key, value] of params) {
    if (key.toLowerCase() !== 'service') continue;
    const v = value.trim().toUpperCase();
    if (v === 'WMS' || v === 'WFS' || v === 'WMTS') return v;
  }
  return null;
}

/** Try ArcGIS REST -- fetch ?f=json and detect the service shape. */
async function tryArcgis(rawUrl: string): Promise<ArcgisServiceDescription> {
  // describeArcgisService takes a parsed JSON body; we mirror probeService's
  // pattern of fetching the URL ourselves and handing the JSON in. Splitting
  // a layer URL is left to the helper.
  const cleaned = rawUrl.replace(/(?<!\/)\/+$/, '');
  const sep = cleaned.includes('?') ? '&' : '?';
  const res = await fetch(`${cleaned}${sep}f=json`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`ArcGIS REST returned ${res.status}.`);
  }
  const json = await res.json();
  // Reject responses that don't look ArcGIS-shaped before handing
  // off to describeArcgisService -- some servers return a generic
  // 200 + HTML for a wrong path, and the parser would otherwise
  // throw a less-clear error.
  if (typeof json !== 'object' || json === null) {
    throw new Error('Not ArcGIS REST.');
  }
  const j = json as Record<string, unknown>;
  if (
    typeof j.currentVersion !== 'number' &&
    !Array.isArray(j.layers) &&
    !Array.isArray(j.services)
  ) {
    throw new Error('Not ArcGIS REST.');
  }
  return describeArcgisService(rawUrl, json);
}

/** ArcGIS REST -> unified ServiceData. Maps MapServer to
 *  arcgis_map, FeatureServer to arcgis_feature, GeocodeServer to
 *  arcgis_geocode (#75). (Image servers can be added later when we
 *  add image support.) */
function arcgisToServiceData(
  desc: ArcgisServiceDescription,
  probedAt: ISODateString,
): ServiceData {
  // GeocodeServer carries no sublayers but does carry per-service
  // address-field metadata. Route to the arcgis_geocode variant so
  // the runtime can render a geocoder-shaped detail page + picker
  // rather than the layer-list pattern the other protocols share.
  if (desc.serviceType === 'GeocodeServer') {
    const data: ServiceData = {
      version: 1,
      protocol: 'arcgis_geocode',
      url: desc.url,
      // Geocoders advertise no sublayers; the empty list keeps the
      // ServiceData shape uniform across protocols.
      layers: [],
      probedAt,
      ...(desc.bbox ? { bbox: desc.bbox } : {}),
      ...(desc.name ? { serviceTitle: desc.name } : {}),
      ...(desc.geocodeAddressFields && desc.geocodeAddressFields.length > 0
        ? { addressFields: desc.geocodeAddressFields }
        : {}),
      ...(desc.geocodeSingleLineField
        ? { singleLineFieldName: desc.geocodeSingleLineField }
        : {}),
      ...(desc.geocodeCountries && desc.geocodeCountries.length > 0
        ? { supportedCountries: desc.geocodeCountries }
        : {}),
      ...(desc.geocodeCapabilities && desc.geocodeCapabilities.length > 0
        ? { capabilities: desc.geocodeCapabilities }
        : {}),
    };
    return data;
  }

  const protocol =
    desc.serviceType === 'FeatureServer' ? 'arcgis_feature' : 'arcgis_map';
  const layers: ServiceLayerSnapshot[] = desc.layers.map((l) => {
    const out: ServiceLayerSnapshot = {
      // Use the integer id stringified as the canonical name; the
      // runtime composes /<id> URLs from this.
      name: String(l.id),
      title: l.name || String(l.id),
    };
    if (l.geometryType) out.geometryType = l.geometryType;
    return out;
  });
  const base = {
    version: 1 as const,
    url: desc.url,
    layers,
    serviceTitle: desc.name || undefined,
    probedAt,
    ...(desc.bbox ? { bbox: desc.bbox } : {}),
  };
  // Stripping `serviceTitle: undefined` for exactOptionalPropertyTypes.
  const cleaned: Record<string, unknown> = { ...base };
  if (cleaned.serviceTitle === undefined) delete cleaned.serviceTitle;
  return { protocol, ...(cleaned as typeof base) } as ServiceData;
}

/** WMS GetCapabilities -> unified ServiceData. */
function wmsToServiceData(
  c: WmsCapabilities,
  probedAt: ISODateString,
): ServiceData {
  const layers: ServiceLayerSnapshot[] = c.layers.map((l) => {
    const out: ServiceLayerSnapshot = { name: l.name, title: l.title };
    if (l.bbox) out.bbox = l.bbox;
    return out;
  });
  const data: ServiceData = {
    version: 1,
    protocol: 'wms',
    url: c.url,
    protocolVersion: c.protocolVersion,
    format: 'image/png',
    transparent: true,
    crs: 'EPSG:3857',
    layers,
    probedAt,
    ...(c.bbox ? { bbox: c.bbox } : {}),
    ...(c.title ? { serviceTitle: c.title } : {}),
  };
  return data;
}

/** WFS GetCapabilities -> unified ServiceData. */
function wfsToServiceData(
  c: WfsCapabilities,
  probedAt: ISODateString,
): ServiceData {
  const layers: ServiceLayerSnapshot[] = c.layers.map((l) => {
    const out: ServiceLayerSnapshot = { name: l.name, title: l.title };
    if (l.bbox) out.bbox = l.bbox;
    return out;
  });
  const data: ServiceData = {
    version: 1,
    protocol: 'wfs',
    url: c.url,
    protocolVersion: c.protocolVersion,
    outputFormat: 'application/json',
    layers,
    probedAt,
    ...(c.bbox ? { bbox: c.bbox } : {}),
    ...(c.title ? { serviceTitle: c.title } : {}),
  };
  return data;
}

/**
 * WMTS GetCapabilities probe (#303 wired through the unified path).
 *
 * WMTS root element is <Capabilities>, contents under
 * Contents/Layer. Each Layer has Identifier (canonical name),
 * Title, optional WGS84BoundingBox, plus Format and TileMatrixSetLink
 * children. Multiple matrix sets per layer are common; we record the
 * first one as the layer's tileMatrixSet and let the wizard / detail
 * page expose a per-layer override later.
 *
 * The protocol version is fixed at 1.0.0 (that's the only version
 * in the wild). If a future WMTS 2.0 ships we'll add the variant.
 */
async function probeWmts(rawUrl: string): Promise<ServiceData> {
  const base = ogcBaseUrl(rawUrl);
  const url = ogcRequestUrl(base, {
    service: 'WMTS',
    request: 'GetCapabilities',
    version: '1.0.0',
  });
  const res = await fetch(url, {
    headers: { Accept: 'application/xml, text/xml, */*' },
  });
  if (!res.ok) throw new Error(`WMTS GetCapabilities returned ${res.status}.`);
  const text = await res.text();
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('WMTS server returned non-XML.');
  }
  return parseWmtsCapabilities(base, doc);
}

/** Exported for tests. Matches elements by local name, since servers
 *  write the OWS parts with a prefix (`ows:Title`, `ows:LowerCorner`). */
export function parseWmtsCapabilities(base: string, doc: Document): ServiceData {
  const root = doc.documentElement;
  // WMTS Capabilities root local name is "Capabilities". Other OGC
  // services also use that name in some namespaces, so also require
  // <Contents> and at least one <Layer>.
  if (root.localName !== 'Capabilities' || byLocalName(root, 'Contents').length === 0) {
    throw new Error(`Not WMTS capabilities (root element ${root.localName}).`);
  }
  const layerEls = byLocalName(root, 'Layer');
  if (layerEls.length === 0) {
    throw new Error('No WMTS Layer elements found.');
  }
  const protocolVersion = (root.getAttribute('version') ?? '1.0.0') as '1.0.0';
  const serviceTitle = directDescendantText(
    byLocalName(root, 'ServiceIdentification')[0] ?? null,
    'Title',
  );

  const layers: ServiceLayerSnapshot[] = [];
  for (const lEl of layerEls) {
    const name = directDescendantText(lEl, 'Identifier');
    const title = directDescendantText(lEl, 'Title') || name;
    if (!name) continue;
    const formatEl = byLocalName(lEl, 'Format')[0];
    const format = formatEl?.textContent?.trim() ?? 'image/png';
    const matrixEl = byLocalName(lEl, 'TileMatrixSet')[0];
    const tileMatrixSet = matrixEl?.textContent?.trim() ?? '';
    const styleId = directDescendantText(
      byLocalName(lEl, 'Style')[0] ?? null,
      'Identifier',
    );
    const bboxEl = byLocalName(lEl, 'WGS84BoundingBox')[0];
    let bbox: [number, number, number, number] | undefined;
    if (bboxEl) {
      const lower = byLocalName(bboxEl, 'LowerCorner')[0]?.textContent ?? '';
      const upper = byLocalName(bboxEl, 'UpperCorner')[0]?.textContent ?? '';
      const lo = lower.trim().split(/\s+/).map(Number);
      const up = upper.trim().split(/\s+/).map(Number);
      if (lo.length === 2 && up.length === 2 && [...lo, ...up].every(Number.isFinite)) {
        bbox = [lo[0]!, lo[1]!, up[0]!, up[1]!];
      }
    }
    const out: ServiceLayerSnapshot = { name, title };
    if (bbox) out.bbox = bbox;
    if (format) out.format = format;
    if (tileMatrixSet) out.tileMatrixSet = tileMatrixSet;
    if (styleId) out.defaultStyle = styleId;
    layers.push(out);
  }

  const probedAt = new Date().toISOString() as ISODateString;
  // Service-level bbox = union of layer bboxes when present.
  const allBboxes = layers
    .map((l) => l.bbox)
    .filter((b): b is [number, number, number, number] => !!b);
  let svcBbox: [number, number, number, number] | undefined;
  if (allBboxes.length > 0) {
    let [w, s, e, n] = allBboxes[0]!;
    for (let i = 1; i < allBboxes.length; i += 1) {
      const b = allBboxes[i]!;
      if (b[0] < w) w = b[0];
      if (b[1] < s) s = b[1];
      if (b[2] > e) e = b[2];
      if (b[3] > n) n = b[3];
    }
    svcBbox = [w, s, e, n];
  }

  const data: ServiceData = {
    version: 1,
    protocol: 'wmts',
    url: base,
    protocolVersion,
    layers,
    probedAt,
    ...(svcBbox ? { bbox: svcBbox } : {}),
    ...(serviceTitle ? { serviceTitle } : {}),
  };
  return data;
}

/** Read the first direct-descendant element matching `localName`'s
 *  text content, ignoring XML namespace prefixes. */
function directDescendantText(parent: Element | null, localName: string): string {
  if (!parent) return '';
  const want = localName.toLowerCase();
  for (const child of Array.from(parent.children)) {
    const local = (child.localName ?? child.tagName.replace(/^.*:/, '')).toLowerCase();
    if (local === want) {
      return child.textContent?.trim() ?? '';
    }
  }
  return '';
}
