// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { sanitizeAttributionHtml } from '@gratis-gis/shared-types';
import {
  parseXml as parseXmlVendored,
  type XmlElement as VendoredXmlElement,
  type XmlValue as VendoredXmlValue,
} from './xml-walker';

import { AdminGuard } from './admin.guard.js';
import {
  assertSafeOutboundUrl,
  isPrivateOrLoopbackHost,
  UnsafeOutboundUrlError,
} from '../common/net-guards.js';

/**
 * Basemap-URL probe (#144). The admin pastes a URL into the
 * basemap editor; this endpoint inspects the URL + (when needed)
 * the remote service's metadata document and returns a populated
 * BasemapData skeleton the editor can drop into its form fields:
 *
 *   { kind, tileUrl?, styleUrl?, wmsUrl?, wmsConfig?, title?,
 *     attribution?, thumbnailUrl?, minZoom?, maxZoom? }
 *
 * Detection rules, in order:
 *
 *   1. URL contains literal `{z}/{x}/{y}` (or `{z}/{y}/{x}`)
 *      placeholders -> kind: 'tile-url'. The URL stays as-is.
 *
 *   2. URL path ends in `/MapServer` or `/MapServer/` (no
 *      `/tile/...` suffix) -> kind: 'tile-url'; fetch the service
 *      `?f=json` metadata to confirm cached tiles are available
 *      (`singleFusedMapCache: true`) and to lift mapName +
 *      copyrightText + thumbnail. Tile template becomes
 *      `{base}/tile/{z}/{y}/{x}` (Esri row-before-column order).
 *
 *   3. URL has `?service=WMTS`, contains a `/wmts/` path segment,
 *      or ends in `WMTSCapabilities.xml` -> kind: 'tile-url'.
 *      Parses the capabilities document, walks all layers,
 *      validates each layer's TileMatrixSet is web-mercator-
 *      compatible (EPSG:3857 / 900913 / GoogleMapsCompatible /
 *      WebMercatorQuad), validates every TileMatrix identifier is
 *      a non-negative integer (so `{TileMatrix}` -> `{z}`
 *      substitution is valid), picks the default Style, and
 *      computes minZoom/maxZoom from the TileMatrix identifiers.
 *      Refuses with a descriptive error when no layer satisfies
 *      these constraints.
 *
 *   4. URL has `?service=WMS` (or path / file extension suggests
 *      WMS) -> kind: 'wms'. Parses the capabilities document,
 *      walks the nested Layer tree, accumulates CRS values from
 *      parent layers (WMS spec: child layers inherit parent CRS),
 *      and picks the first queryable layer (one with a Name) whose
 *      effective CRS list contains EPSG:3857. Version-aware:
 *      reads `CRS` for WMS >= 1.3.0 and `SRS` for earlier
 *      versions.
 *
 *   5. URL responds with `application/json` and the body looks
 *      like a MapLibre style (has `version`, `sources`, `layers`)
 *      -> kind: 'style-url'.
 *
 * Anything else returns 400 with a polite "couldn't detect"
 * message; the admin can still configure the basemap manually.
 *
 * Why admin-only: the endpoint makes outbound requests to a URL
 * the caller chooses. We don't want anonymous internet visitors
 * using the portal as a side-channel scanner against internal
 * networks. AdminGuard restricts to org admins.
 */
@ApiTags('admin', 'basemap')
@ApiBearerAuth()
@Controller('admin/basemap')
@UseGuards(AdminGuard)
export class AdminBasemapProbeController {
  private readonly log = new Logger(AdminBasemapProbeController.name);

  @Get('probe')
  async probe(@Query('url') rawUrl?: string): Promise<BasemapProbeResult> {
    // Every attribution this endpoint discovers comes out of a document
    // a third-party server wrote (ArcGIS `copyrightText`, WMS / WMTS
    // `AccessConstraints`), goes straight into the basemap editor's form
    // state, and is saved onto the item from there. MapLibre renders it
    // as HTML, and the sanitizer it uses to do that is bypassable on the
    // version we are pinned to, so it is cleaned before it leaves the
    // API. One wrapper rather than one call per branch: `probeUrl` has
    // five detection paths and more will be added, and a per-branch fix
    // is a hole waiting for the sixth.
    const result = await this.probeUrl(rawUrl);
    return result.attribution === undefined
      ? result
      : { ...result, attribution: sanitizeAttributionHtml(result.attribution) };
  }

  private async probeUrl(rawUrl?: string): Promise<BasemapProbeResult> {
    if (!rawUrl || typeof rawUrl !== 'string') {
      throw new BadRequestException('Missing url parameter.');
    }
    const url = rawUrl.trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException('Not a valid URL.');
    }
    // Block obvious internal-network ranges; AdminGuard already
    // restricts to org admins but a defense-in-depth on the
    // hostname keeps us from being an accidental SSRF surface.
    // Numeric IPs in private ranges + loopback + link-local are
    // refused outright. DNS-resolving hostnames are forwarded
    // (we don't try to resolve here; the admin-only audience is
    // assumed reasonable). Caddy/portal-web also network-isolate
    // the api container.
    if (isPrivateOrLoopbackHost(parsed.hostname)) {
      throw new BadRequestException(
        'Probing private / loopback addresses is not allowed.',
      );
    }

    // (0) PMTiles URL (#179). pmtiles:// URLs are consumed by
    // MapLibre's pmtiles protocol plugin (range-reads the
    // underlying HTTP URL). They don't have {z}/{x}/{y}
    // placeholders, so the XYZ-template check below would miss
    // them, AND none of the OGC / ArcGIS probe branches can
    // fetch a pmtiles: scheme. Short-circuit before any of that.
    if (url.startsWith('pmtiles://')) {
      return {
        kind: 'tile-url',
        tileUrl: url,
      };
    }

    // (1) XYZ tile template. Cheap; no network call.
    if (looksLikeXyzTemplate(url)) {
      return {
        kind: 'tile-url',
        tileUrl: url,
      };
    }

    // (2) ArcGIS MapServer.
    if (looksLikeArcgisMapServer(parsed)) {
      try {
        return await this.probeArcgisMapServer(parsed);
      } catch (err) {
        this.log.warn(
          `MapServer probe failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Fall through to the generic style probe; some MapServer
        // URLs respond to ?f=json with errors but still serve
        // tiles, so a manual tile-url paste might still work.
      }
    }

    // (3) WMTS GetCapabilities. Checked BEFORE WMS because the
    // detectors don't overlap (WMS keys on /wms, WMTS keys on
    // /wmts) but we want WMTS-first ordering documented.
    if (looksLikeWmts(parsed)) {
      try {
        return await this.probeWmts(parsed);
      } catch (err) {
        this.log.warn(
          `WMTS probe failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Re-throw if the detector is confident this is WMTS, so
        // the operator sees the actual reason. The KVP fall-back
        // logic of WMS detection won't help a WMTS document.
        throw new BadRequestException(
          err instanceof Error ? err.message : 'WMTS probe failed.',
        );
      }
    }

    // (4) WMS GetCapabilities.
    if (looksLikeWms(parsed)) {
      try {
        return await this.probeWms(parsed);
      } catch (err) {
        this.log.warn(
          `WMS probe failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw new BadRequestException(
          err instanceof Error ? err.message : 'WMS probe failed.',
        );
      }
    }

    // (5) MapLibre style.json.
    try {
      const styleResult = await this.probeStyle(url);
      if (styleResult) return styleResult;
    } catch (err) {
      this.log.warn(
        `Style probe failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    throw new BadRequestException(
      'Could not detect a recognized basemap format at that URL. ' +
        'Supported: XYZ tile template ({z}/{x}/{y} placeholders), ArcGIS ' +
        'MapServer, WMTS GetCapabilities, WMS GetCapabilities, or MapLibre ' +
        'style.json.',
    );
  }

  // ----------------------------------------------------------------

  private async probeArcgisMapServer(
    parsed: URL,
  ): Promise<BasemapProbeResult> {
    const base = parsed.toString().replace(/\/+$/, '');
    const metaUrl = `${base}?f=json`;
    const res = await fetchWithTimeout(metaUrl, 10_000);
    if (!res.ok) {
      throw new Error(`MapServer ?f=json returned ${res.status}`);
    }
    type EsriMapServer = {
      mapName?: string;
      copyrightText?: string;
      documentInfo?: { Title?: string };
      singleFusedMapCache?: boolean;
      tileInfo?: { lods?: Array<{ level: number }> };
      minLOD?: number;
      maxLOD?: number;
    };
    const meta = (await res.json()) as EsriMapServer;
    const title =
      (meta.mapName && meta.mapName.trim()) ||
      (meta.documentInfo?.Title && meta.documentInfo.Title.trim()) ||
      undefined;
    const attribution =
      meta.copyrightText && meta.copyrightText.trim()
        ? meta.copyrightText.trim()
        : undefined;
    // Esri tile URL convention is /tile/{level}/{row}/{col} which
    // MapLibre expresses as /tile/{z}/{y}/{x}. The row-before-
    // column swap matters; getting it backwards gives mirrored
    // tiles that don't blow up but are obviously wrong.
    const tileUrl = `${base}/tile/{z}/{y}/{x}`;
    // LOD range becomes minzoom / maxzoom so MapLibre doesn't try
    // to fetch tiles outside the cached pyramid (which 404s noisy
    // log spam).
    const lods = meta.tileInfo?.lods;
    let minZoom: number | undefined;
    let maxZoom: number | undefined;
    if (Array.isArray(lods) && lods.length > 0) {
      const levels = lods
        .map((l) => l.level)
        .filter((n): n is number => typeof n === 'number');
      if (levels.length > 0) {
        minZoom = Math.min(...levels);
        maxZoom = Math.max(...levels);
      }
    }
    return {
      kind: 'tile-url',
      tileUrl,
      ...(title ? { title } : {}),
      ...(attribution ? { attribution } : {}),
      ...(minZoom !== undefined ? { minZoom } : {}),
      ...(maxZoom !== undefined ? { maxZoom } : {}),
    };
  }

  private async probeWmts(parsed: URL): Promise<BasemapProbeResult> {
    // WMTS exposes capabilities two ways:
    //   * RESTful:  .../wmts/1.0.0/WMTSCapabilities.xml
    //   * KVP:      .../wmts?service=WMTS&request=GetCapabilities&version=1.0.0
    // If the caller already pasted the capabilities document URL we
    // use it verbatim; otherwise we synthesize the KVP form.
    const lowerPath = parsed.pathname.toLowerCase();
    const looksLikeCapsDoc = lowerPath.endsWith('wmtscapabilities.xml');
    const capsUrl = looksLikeCapsDoc
      ? parsed.toString()
      : `${parsed.origin}${parsed.pathname}?service=WMTS&request=GetCapabilities&version=1.0.0`;
    const res = await fetchWithTimeout(capsUrl, 10_000);
    if (!res.ok) {
      throw new Error(`WMTS GetCapabilities returned ${res.status}`);
    }
    const xml = await res.text();

    const doc = parseXml(xml);
    const caps = asElement(doc.Capabilities);
    if (!caps) {
      throw new Error('Response is not a WMTS Capabilities document.');
    }

    // Service-level title + attribution. The OWS namespace prefix
    // is stripped by the parser (`removeNSPrefix: true`), so a
    // server using `ows:Title` or `wmts:Title` lands at the same
    // key as one using bare `Title`.
    const svcId = asElement(caps.ServiceIdentification);
    const svcProvider = asElement(caps.ServiceProvider);
    const title = textOf(svcId?.Title);
    const attribution =
      textOf(svcId?.AccessConstraints) ?? textOf(svcProvider?.ProviderName);

    const contents = asElement(caps.Contents);
    if (!contents) {
      throw new Error('WMTS Capabilities has no <Contents> block.');
    }

    const layers = toArray(contents.Layer).filter(isElement);
    if (layers.length === 0) {
      throw new Error('No <Layer> found in WMTS Contents.');
    }

    // Build a TileMatrixSet lookup keyed by Identifier so each
    // layer's TileMatrixSetLink reference resolves to the actual
    // matrix definition with its CRS and TileMatrix list.
    const tmsList = toArray(contents.TileMatrixSet).filter(isElement);
    const tmsById = new Map<string, XmlElement>();
    for (const tms of tmsList) {
      const id = textOf(tms.Identifier);
      if (id) tmsById.set(id, tms);
    }

    // Walk every (layer, TileMatrixSetLink) combination and accept
    // the first one that passes all four checks: (a) layer has a
    // RESTful ResourceURL with resourceType="tile", (b) the
    // referenced TileMatrixSet exists, (c) its SupportedCRS is
    // web-mercator-compatible, (d) every TileMatrix identifier in
    // the set is a non-negative integer (required so MapLibre's
    // {z} placeholder can directly substitute the WMTS
    // {TileMatrix} identifier).
    const rejections: string[] = [];
    let chosen: ChosenWmtsLayer | undefined;
    layerLoop: for (const layer of layers) {
      const layerLabel = textOf(layer.Identifier) ?? '(unnamed layer)';
      const tileResource = toArray(layer.ResourceURL)
        .filter(isElement)
        .find(
          (r) =>
            r['@_resourceType'] === 'tile' &&
            typeof r['@_template'] === 'string',
        );
      if (!tileResource) {
        rejections.push(
          `${layerLabel}: no RESTful <ResourceURL resourceType="tile">`,
        );
        continue;
      }
      const template = String(tileResource['@_template']);
      const links = toArray(layer.TileMatrixSetLink).filter(isElement);
      for (const link of links) {
        const tmsRef = textOf(link.TileMatrixSet);
        if (!tmsRef) continue;
        const tms = tmsById.get(tmsRef);
        if (!tms) {
          rejections.push(
            `${layerLabel}: references unknown TileMatrixSet "${tmsRef}"`,
          );
          continue;
        }
        const crs = textOf(tms.SupportedCRS);
        // Accept either CRS-encoded web mercator markers
        // (EPSG:3857, EPSG:900913, with or without URN wrappers)
        // OR the de-facto-standard identifiers that imply web
        // mercator (GoogleMapsCompatible, WebMercatorQuad). The
        // identifier check is a fallback for servers that omit
        // SupportedCRS.
        if (!isWebMercatorCrs(crs) && !isWebMercatorCrs(tmsRef)) {
          rejections.push(
            `${layerLabel}: TileMatrixSet "${tmsRef}" CRS "${crs ?? 'unknown'}" is not web mercator`,
          );
          continue;
        }
        const matrices = toArray(tms.TileMatrix).filter(isElement);
        const matrixIds = matrices.map((m) => textOf(m.Identifier));
        if (
          matrixIds.length === 0 ||
          !matrixIds.every((id) => id !== undefined && /^\d+$/.test(id))
        ) {
          rejections.push(
            `${layerLabel}: TileMatrixSet "${tmsRef}" has non-integer TileMatrix identifiers (cannot map to MapLibre {z})`,
          );
          continue;
        }
        const levels = matrixIds.map((id) => parseInt(id as string, 10));
        chosen = {
          layer,
          tms,
          template,
          minZoom: Math.min(...levels),
          maxZoom: Math.max(...levels),
        };
        break layerLoop;
      }
    }

    if (!chosen) {
      const detail =
        rejections.length > 0
          ? ' Details: ' + rejections.slice(0, 3).join('; ')
          : '';
      throw new Error(
        `No WMTS layer in this capabilities document satisfies the basemap constraints (RESTful tile ResourceURL, web-mercator TileMatrixSet, integer TileMatrix identifiers).${detail}`,
      );
    }

    // Substitute the WMTS template placeholders. {Layer}, {Style},
    // {TileMatrixSet} resolve from the capabilities document; the
    // coordinate triple maps onto MapLibre's XYZ source convention.
    const layerIdentifier = textOf(chosen.layer.Identifier);
    const styles = toArray(chosen.layer.Style).filter(isElement);
    // Spec: <Style isDefault="true"> marks the default; fall back
    // to the first style if no default is flagged (most public
    // services use exactly one style, often named "default").
    const defaultStyle =
      styles.find((s) => s['@_isDefault'] === 'true') ?? styles[0];
    const styleIdentifier = defaultStyle
      ? textOf(defaultStyle.Identifier)
      : undefined;
    const tmsIdentifier = textOf(chosen.tms.Identifier);

    let template = chosen.template;
    if (layerIdentifier) {
      template = template.replace(/\{Layer\}/g, layerIdentifier);
    }
    if (styleIdentifier) {
      template = template.replace(/\{Style\}/g, styleIdentifier);
    }
    if (tmsIdentifier) {
      template = template.replace(/\{TileMatrixSet\}/g, tmsIdentifier);
    }
    template = template
      .replace(/\{TileMatrix\}/g, '{z}')
      .replace(/\{TileRow\}/g, '{y}')
      .replace(/\{TileCol\}/g, '{x}');

    return {
      kind: 'tile-url',
      tileUrl: template,
      ...(title ? { title } : {}),
      ...(attribution ? { attribution } : {}),
      minZoom: chosen.minZoom,
      maxZoom: chosen.maxZoom,
    };
  }

  private async probeWms(parsed: URL): Promise<BasemapProbeResult> {
    // Strip whatever query the URL had; GetCapabilities is a
    // standard request we compose ourselves. Default to 1.3.0
    // because it's the current spec; servers that only speak
    // 1.1.1 typically still answer a 1.3.0 request with their
    // 1.1.1 doc (and the parser handles both via the dual root
    // element check below).
    const base = `${parsed.origin}${parsed.pathname}`;
    const capsUrl = `${base}?service=WMS&request=GetCapabilities&version=1.3.0`;
    const res = await fetchWithTimeout(capsUrl, 10_000);
    if (!res.ok) {
      throw new Error(`WMS GetCapabilities returned ${res.status}`);
    }
    const xml = await res.text();

    const doc = parseXml(xml);
    // WMS 1.3.0 uses <WMS_Capabilities>; earlier versions
    // (1.1.x and 1.0.0) use <WMT_MS_Capabilities>. Check both.
    const root =
      asElement(doc.WMS_Capabilities) ?? asElement(doc.WMT_MS_Capabilities);
    if (!root) {
      throw new Error('Response is not a WMS Capabilities document.');
    }
    const versionAttr = root['@_version'];
    const version =
      typeof versionAttr === 'string' && versionAttr.length > 0
        ? versionAttr
        : '1.3.0';
    // WMS 1.3.0 introduced the <CRS> tag; earlier versions used
    // <SRS>. The GetMap CRS/SRS parameter name follows the same
    // split. We read the appropriate tag per version.
    const crsTagName: 'CRS' | 'SRS' =
      compareVersion(version, '1.3.0') >= 0 ? 'CRS' : 'SRS';

    // Service-level title + attribution
    const service = asElement(root.Service);
    const title = textOf(service?.Title);
    const contactInfo = asElement(service?.ContactInformation);
    const contactPerson = asElement(contactInfo?.ContactPersonPrimary);
    const attribution =
      textOf(service?.AccessConstraints) ??
      textOf(contactPerson?.ContactOrganization);

    // The <Capability><Layer> root is conventionally a non-
    // queryable container holding nested Layer elements. The
    // WMS spec says CRS values inherit from parent to child, so
    // we walk depth-first with accumulating inherited CRS and
    // pick the first leaf (Name-bearing) layer whose effective
    // CRS set includes a web-mercator value.
    const capability = asElement(root.Capability);
    const rootLayer = asElement(capability?.Layer);
    if (!rootLayer) {
      throw new Error('WMS Capabilities has no <Capability><Layer>.');
    }
    const layerName = findFirstWebMercatorWmsLayer(rootLayer, crsTagName, []);
    if (!layerName) {
      throw new Error(
        'No queryable WMS layer in this server advertises support for EPSG:3857 (web mercator). MapLibre basemaps require web mercator.',
      );
    }

    return {
      kind: 'wms',
      wmsUrl: base,
      wmsConfig: {
        layers: layerName,
        format: 'image/png',
        transparent: true,
        version,
        crs: 'EPSG:3857',
      },
      ...(title ? { title } : {}),
      ...(attribution ? { attribution } : {}),
    };
  }

  private async probeStyle(url: string): Promise<BasemapProbeResult | null> {
    const res = await fetchWithTimeout(url, 10_000);
    if (!res.ok) return null;
    const ctype = res.headers.get('content-type') ?? '';
    if (!/json/.test(ctype)) return null;
    const body = (await res.json()) as {
      version?: unknown;
      sources?: unknown;
      layers?: unknown;
      name?: unknown;
    };
    if (
      typeof body.version !== 'number' ||
      typeof body.sources !== 'object' ||
      !Array.isArray(body.layers)
    ) {
      return null;
    }
    const title =
      typeof body.name === 'string' && body.name.length > 0
        ? body.name
        : undefined;
    return {
      kind: 'style-url',
      styleUrl: url,
      ...(title ? { title } : {}),
    };
  }
}

/**
 * Wire shape returned by GET /admin/basemap/probe. Mirrors the
 * BasemapData shape closely so the frontend can spread it
 * straight into a form-state object.
 */
export interface BasemapProbeResult {
  kind: 'tile-url' | 'wms' | 'style-url';
  tileUrl?: string;
  styleUrl?: string;
  wmsUrl?: string;
  wmsConfig?: {
    layers: string;
    format?: string;
    transparent?: boolean;
    version?: string;
    crs?: string;
  };
  title?: string;
  attribution?: string;
  thumbnailUrl?: string;
  minZoom?: number;
  maxZoom?: number;
}

// ----------------------------------------------------------------
// XML parsing utilities
// ----------------------------------------------------------------

/**
 * Loose typing for a parsed XML node. Mirrors what the vendored
 * walker (./xml-walker) returns: each element is either a string
 * (text-only elements), an XmlElement (one child of each name), or
 * an array of XmlElement / strings (siblings with the same name).
 * Attribute values land under keys prefixed with `@_`, and mixed
 * content (attributes + text) appears as `#text: '...'`. Namespace
 * prefixes (`ows:`, `wmts:`, `xlink:`, etc.) are stripped so every
 * server's variant of <ows:Title> / <wmts:Title> / <Title> lands at
 * the same key.
 */
type XmlValue = VendoredXmlValue;
type XmlElement = VendoredXmlElement;

function parseXml(xml: string): XmlElement {
  try {
    return parseXmlVendored(xml);
  } catch (err) {
    throw new Error(
      `Could not parse XML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function isElement(value: unknown): value is XmlElement {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asElement(value: XmlValue | undefined): XmlElement | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    // If the parser saw multiple siblings (rare for the elements
    // we look up at single-cardinality positions like Service or
    // Capability) we take the first as the canonical one.
    const first = value[0];
    return isElement(first) ? first : undefined;
  }
  return isElement(value) ? value : undefined;
}

/**
 * Extract the text content of a node. Handles three shapes that
 * fast-xml-parser emits:
 *   - bare string for elements with only text content
 *   - { '#text': 'value', '@_attr': '...' } for elements with
 *     both attributes and text
 *   - undefined / object-without-#text yields undefined
 * Whitespace is preserved as the parser already trims (trimValues).
 */
function textOf(value: XmlValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    return value.length > 0 ? value : undefined;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (Array.isArray(value)) {
    // Multiple children of the same name: take the first text-
    // bearing one. Used for tags like <Keyword>foo</Keyword>
    // that repeat; we want a representative value.
    for (const item of value) {
      const t = textOf(item);
      if (t) return t;
    }
    return undefined;
  }
  if (isElement(value)) {
    const t = value['#text'];
    if (typeof t === 'string') return t.length > 0 ? t : undefined;
    if (typeof t === 'number') return String(t);
  }
  return undefined;
}

function toArray(value: XmlValue | undefined): XmlValue[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

// ----------------------------------------------------------------
// WMTS / WMS helpers
// ----------------------------------------------------------------

interface ChosenWmtsLayer {
  layer: XmlElement;
  tms: XmlElement;
  template: string;
  minZoom: number;
  maxZoom: number;
}

/**
 * Is `crsString` a web-mercator CRS identifier in any of the
 * forms WMTS / WMS services use? The spec allows several
 * encodings of the same projection:
 *   - "EPSG:3857" (WMS 1.3.0 short form)
 *   - "urn:ogc:def:crs:EPSG::3857" (URN with empty version)
 *   - "urn:ogc:def:crs:EPSG:6.18:3:3857" (URN with version)
 *   - "http://www.opengis.net/def/crs/EPSG/0/3857" (HTTP URI)
 *   - "EPSG:900913" (Google's legacy alias, still served by
 *     some older Mapproxy / GeoServer installations)
 *   - "GoogleMapsCompatible" / "WebMercatorQuad" (de-facto-
 *     standard WMTS TileMatrixSet identifiers that imply 3857)
 * We match the four-digit EPSG codes with a word boundary so a
 * spurious "38573" wouldn't match.
 */
function isWebMercatorCrs(crsString: string | undefined): boolean {
  if (!crsString) return false;
  if (/\b(?:3857|900913)\b/.test(crsString)) return true;
  if (/googlemapscompatible/i.test(crsString)) return true;
  if (/webmercatorquad/i.test(crsString)) return true;
  return false;
}

/**
 * Depth-first walk of a WMS Layer tree. WMS layers nest, and the
 * spec requires child layers to inherit their parent's CRS list.
 * We accumulate inherited CRS through the recursion, and return
 * the Name of the first layer that (a) has a Name attribute (i.e.
 * is queryable) AND (b) advertises web mercator in its effective
 * CRS set (own + inherited).
 *
 * `crsTagName` is 'CRS' for WMS >= 1.3.0 and 'SRS' for earlier.
 */
function findFirstWebMercatorWmsLayer(
  layer: XmlElement,
  crsTagName: 'CRS' | 'SRS',
  inheritedCrs: string[],
): string | undefined {
  const ownCrs = toArray(layer[crsTagName])
    .map(textOf)
    .filter((s): s is string => typeof s === 'string');
  const effectiveCrs = [...inheritedCrs, ...ownCrs];

  const name = textOf(layer.Name);
  if (name && effectiveCrs.some(isWebMercatorCrs)) {
    return name;
  }

  const children = toArray(layer.Layer).filter(isElement);
  for (const child of children) {
    const hit = findFirstWebMercatorWmsLayer(child, crsTagName, effectiveCrs);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Compare two dotted-numeric versions ("1.1.1" vs "1.3.0").
 * Returns positive when a > b, negative when a < b, 0 when equal.
 * Sufficient for WMS version comparison; not a general semver
 * implementation.
 */
function compareVersion(a: string, b: string): number {
  const aP = a.split('.').map((n) => parseInt(n, 10));
  const bP = b.split('.').map((n) => parseInt(n, 10));
  const len = Math.max(aP.length, bP.length);
  for (let i = 0; i < len; i++) {
    const ai = Number.isFinite(aP[i]) ? (aP[i] as number) : 0;
    const bi = Number.isFinite(bP[i]) ? (bP[i] as number) : 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

// ----------------------------------------------------------------
// URL / network helpers
// ----------------------------------------------------------------

function looksLikeXyzTemplate(url: string): boolean {
  // Accept the common placeholder shapes: {z}/{x}/{y} (XYZ
  // convention), {z}/{y}/{x} (Esri convention if the user pasted
  // a pre-shaped Esri tile URL).
  //
  // Implemented as three indexOf checks rather than a regex with
  // unbounded `.*` between fixed tokens: the regex form was
  // O(n^3) on inputs full of '{z}{x}{y}' repetitions (catastrophic
  // backtracking flagged by CodeQL js/polynomial-redos).
  const lower = url.toLowerCase();
  const z = lower.indexOf('{z}');
  if (z < 0) return false;
  const x = lower.indexOf('{x}', z + 3);
  const y = lower.indexOf('{y}', z + 3);
  if (x < 0 || y < 0) return false;
  // Either order: {z}...{x}...{y} or {z}...{y}...{x}.
  return (
    (x < y && lower.indexOf('{y}', x + 3) >= 0) ||
    (y < x && lower.indexOf('{x}', y + 3) >= 0)
  );
}

function looksLikeArcgisMapServer(parsed: URL): boolean {
  // Path ends in /MapServer or /MapServer/. Anything below
  // /MapServer/ (sub-layer, query, etc.) is NOT a basemap input;
  // those are feature/raster service URLs that go through the
  // arcgis_service item type instead.
  return /\/MapServer\/?$/i.test(parsed.pathname);
}

function looksLikeWmts(parsed: URL): boolean {
  const qs = parsed.searchParams;
  const service = (qs.get('service') ?? qs.get('SERVICE') ?? '').toLowerCase();
  if (service === 'wmts') return true;
  // Path-based detection: `/wmts/` segment, or a capabilities
  // document filename. Case-insensitive because some servers
  // serve `WMTSCapabilities.xml` and others `wmtscapabilities.xml`.
  if (/(^|\/)wmts(\/|$)/i.test(parsed.pathname)) return true;
  if (/wmtscapabilities\.xml$/i.test(parsed.pathname)) return true;
  return false;
}

function looksLikeWms(parsed: URL): boolean {
  const qs = parsed.searchParams;
  const service = (qs.get('service') ?? qs.get('SERVICE') ?? '').toLowerCase();
  if (service === 'wms') return true;
  // Some servers expose `/wms` or `/services/wms` paths even
  // without an explicit service= param.
  if (/(^|\/)wms(\/|$)/i.test(parsed.pathname)) return true;
  return false;
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    // Route every probe fetch through the SSRF guard (DNS-resolution
    // + private-range block). The endpoint-level check at line ~99
    // catches obvious internal URLs early; this catches the DNS-
    // rebinding case where a public hostname resolves to an internal
    // IP. Throws UnsafeOutboundUrlError on a private resolution; we
    // surface it as a 400 so the admin sees a useful message.
    const safe = await assertSafeOutboundUrl(url);
    const res = await fetch(safe, {
      signal: ctrl.signal,
      // Force a small user-agent so upstream logs see "GratisGIS"
      // instead of "node". Some services (looking at you, ArcGIS
      // Online tiers) gate the JSON metadata behind a UA filter.
      headers: { 'user-agent': 'GratisGIS/probe' },
    });
    return res;
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) {
      throw new BadRequestException(err.message);
    }
    if (err instanceof Error && err.name === 'AbortError') {
      throw new HttpException(
        'Probe timed out (10s). Check the URL or try again.',
        HttpStatus.GATEWAY_TIMEOUT,
      );
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}
