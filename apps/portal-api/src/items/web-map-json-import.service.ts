// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  type EsriWebMap,
  type Lens,
  type LensAttrFilter,
  type LensView,
  webMapJsonToLenses,
} from '@gratis-gis/engine';
import {
  DEFAULT_LAYER_ACCESS,
  DEFAULT_LAYER_INTERACTIONS,
  DEFAULT_LAYER_LABELS,
  DEFAULT_LAYER_POPUP,
  DEFAULT_LAYER_SCALE,
  DEFAULT_LAYER_SEARCH,
  DEFAULT_LAYER_STYLE,
} from '@gratis-gis/shared-types';
import type {
  MapFilterOp,
  MapLayer,
  MapLayerFilter,
  MapLayerStyle,
} from '@gratis-gis/shared-types';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ItemsService } from './items.service.js';

/**
 * Import an Esri WebMap JSON document and create a portal `map`
 * item from it. The reverse direction of
 * `WebMapJsonService.buildForMap` (`GET /items/:id/web-map.json`).
 *
 * The resolver is best-effort:
 *
 *   - Portal per-sublayer URLs (the exact
 *     `/api/items/<id>/layers/<key>/geojson` and
 *     `/api/items/<id>/layers/<key>/tile/{z}/{x}/{y}.mvt` shapes
 *     our own exporter emits) become `kind: 'data-layer'` sources,
 *     so a portal map round-trips its own export.
 *   - Each remaining operationalLayer URL is matched against the
 *     org's existing arcgis_service items. If a match is found,
 *     the resulting MapLayer references that item directly via a
 *     `kind: 'arcgis-rest'` source pointed at the same URL.
 *   - Unmatched FeatureServer / MapServer URLs become bare
 *     `kind: 'arcgis-rest'` MapLayers with the URL persisted
 *     verbatim. The user can later re-link them to a portal
 *     arcgis_service item if they create one.
 *   - Plain GeoJSON file URLs (anything ending in `.geojson` or
 *     `.json`) become `kind: 'geojson-url'`.
 *   - Anything else surfaces as a warning and is skipped.
 *
 * Basemap resolution: pulls every basemap item in the calling
 * user's org and matches by tileUrl. No match -> falls back to
 * the empty-string sentinel, which the portal viewer treats as
 * "use the org default."
 *
 * Viewpoint -> MapData: the WebMap's `initialState.viewpoint`
 * envelope center becomes `MapData.center`; the scale is
 * converted back to a MapLibre zoom via
 * `log2(591657550.5 / scale)`. A WebMap without initialState
 * gets a fallback center of [0, 0] / zoom 2 so the resulting
 * map item is renderable.
 *
 * Authorization: the calling user has to have create-item rights
 * (any authenticated user with a `contributor` org role does).
 * Per-layer ACL on referenced arcgis_service items is NOT
 * re-checked here -- the import is a metadata operation; data
 * fetches still go through the per-item gate at fetch time.
 *
 * The service returns the new item id plus a list of warnings
 * the import UI should surface to the user as a dry-run summary.
 */
@Injectable()
export class WebMapJsonImportService {
  private readonly log = new Logger(WebMapJsonImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly items: ItemsService,
  ) {}

  async import(args: {
    user: AuthUser;
    webMap: EsriWebMap;
    /**
     * Optional: title for the new map item. Defaults to the
     * WebMap's authoringApp + "import" suffix, or "Imported web
     * map" if no authoringApp is declared.
     */
    title?: string;
    /**
     * Optional: description for the new map item. Surfaced on the
     * detail page like any user-authored description.
     */
    description?: string;
    /**
     * Optional: sharing scope for the new map item. Defaults to
     * 'private' to preserve the original (pre-AGO-importer)
     * behaviour; callers that want to mirror an upstream
     * sharing scope pass it explicitly.
     */
    access?: 'private' | 'org' | 'public';
    /**
     * Optional: lookup the AGO importer fills with newly-imported
     * data_layers so this converter can resolve a WebMap layer
     * URL like `<serviceUrl>/<n>` into a portal-rooted
     * `{ kind: 'data-layer', itemId, layerKey }` source instead
     * of leaving the layer pointing at AGO. Key is the canonical
     * (normalized, lowercase, no sublayer suffix) service URL;
     * value carries the portal item id and a per-AGO-layer-id
     * map onto the data_layer's sublayer keys.
     *
     * When unset (every caller pre-AGO-importer-phase-6) the
     * converter falls back to the arcgis_service / geojson-url
     * paths, matching the historical behaviour.
     */
    agoDataLayerLookup?: Map<
      string,
      {
        itemId: string;
        agoLayerIdToSublayerKey: Record<number, string>;
      }
    >;
  }): Promise<{
    itemId: string;
    warnings: string[];
    layerCount: number;
    skippedLayerCount: number;
    /** Count of operational-layer URLs that matched a newly-imported
     *  portal data_layer (via agoDataLayerLookup) and were rerouted
     *  to a portal-rooted source. Surfaces in the import report so
     *  the operator can see the "no longer pointing at AGO" effect. */
    remappedToDataLayerCount: number;
  }> {
    const { user, webMap } = args;

    // Engine-level parse + per-layer translation. Throws on
    // missing version or no usable operationalLayers.
    let parsed: ReturnType<typeof webMapJsonToLenses>;
    try {
      parsed = webMapJsonToLenses(webMap);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Invalid Esri WebMap JSON',
      );
    }
    const warnings = [...parsed.warnings];

    // Pre-load the org's arcgis_service items so we can match
    // FeatureServer / MapServer URLs against them in one pass.
    const arcgisItems = await this.prisma.item.findMany({
      where: {
        orgId: user.orgId,
        type: 'arcgis_service',
        deletedAt: null,
      },
      select: { id: true, data: true },
    });
    const arcgisByUrl = new Map<string, string>();
    for (const it of arcgisItems) {
      const url = (it.data as { url?: unknown } | null)?.url;
      if (typeof url === 'string' && url.length > 0) {
        // Store both the exact URL and the URL with the trailing
        // /<layerId> stripped so a match against either survives.
        arcgisByUrl.set(url, it.id);
        const stripped = url.replace(/\/\d+\/?$/, '');
        if (stripped !== url) arcgisByUrl.set(stripped, it.id);
      }
    }

    // Walk every translated lens and build the corresponding
    // MapLayer record. The lens carries the original URL stashed
    // under query.sourceUrl; we never persist the lens itself
    // since v1 doesn't have a Lens registry.
    const layers: MapLayer[] = [];
    let skipped = 0;
    let remappedToDataLayerCount = 0;
    for (const lens of parsed.lenses) {
      const sourceUrl = (lens.query as { sourceUrl?: string }).sourceUrl;
      if (!sourceUrl) {
        skipped += 1;
        warnings.push(
          `Lens "${lens.name}" has no source URL; skipped.`,
        );
        continue;
      }
      // First chance: if the AGO importer just brought this
      // FeatureServer in as a portal data_layer, point the new map
      // at the portal item directly. Without this, the map would
      // stay tethered to AGO even after the data is sitting in
      // our PostGIS.
      const dataLayerSource = args.agoDataLayerLookup
        ? matchAgoDataLayerSource(sourceUrl, args.agoDataLayerLookup)
        : null;
      if (dataLayerSource) {
        layers.push(buildMapLayer({ lens, source: dataLayerSource, warnings }));
        remappedToDataLayerCount += 1;
        continue;
      }
      const mapped = mapSourceFromUrl({
        url: sourceUrl,
        renderKind: lens.render.kind,
        arcgisByUrl,
      });
      if (!mapped) {
        skipped += 1;
        warnings.push(
          `Layer "${lens.name}" URL was unrecognised (${sourceUrl}); skipped.`,
        );
        continue;
      }
      layers.push(buildMapLayer({ lens, source: mapped, warnings }));
    }

    if (layers.length === 0) {
      throw new BadRequestException(
        'WebMap import produced zero usable layers. ' +
          'Check that the source has at least one ArcGISFeatureLayer or VectorTileLayer.',
      );
    }

    // MapData.layers index 0 is the TOP of the portal render stack;
    // Esri operationalLayers index 0 is the BOTTOM (drawn first, per
    // the WebMap spec). Flip the document order at this boundary so
    // the imported map stacks the way the source map did. Reversed
    // after the walk rather than by iterating backwards so warnings
    // stay in document order.
    layers.reverse();

    // Resolve the basemap to a portal item by tileUrl match. No
    // match -> empty string sentinel; the viewer falls back to
    // the org default at render time.
    const basemap = await this.resolveBasemap(user, webMap);

    // Build the canonical MapData payload. center / zoom come
    // from the WebMap's initialState if present; otherwise we
    // emit a defensible default so the resulting item renders.
    const view = parsed.view;
    const mapData = {
      version: 1 as const,
      basemap,
      center: view?.center ?? [0, 0],
      zoom: view?.zoom ?? 2,
      bearing: view?.bearing ?? 0,
      pitch: view?.pitch ?? 0,
      layers,
      search: { enabled: true, geocoding: true },
    };

    const title =
      (args.title?.trim() || guessTitle(webMap)) || 'Imported web map';

    const created = await this.items.create(user, {
      type: 'map',
      title,
      ...(args.description !== undefined && { description: args.description }),
      data: mapData as unknown as Prisma.InputJsonValue,
      access: args.access ?? 'private',
    });

    this.log.log(
      `Imported WebMap as map item ${created.id} for user ${user.id} ` +
        `(${layers.length} layer(s), ${skipped} skipped, ${warnings.length} warning(s))`,
    );
    return {
      itemId: created.id,
      warnings,
      layerCount: layers.length,
      skippedLayerCount: skipped,
      remappedToDataLayerCount,
    };
  }

  /**
   * Match the WebMap's basemap tileUrl against the calling user's
   * org's basemap items. Returns the matching item id, or empty
   * string if nothing matches (the viewer treats empty as
   * "use the org default seeded basemap").
   */
  private async resolveBasemap(
    user: AuthUser,
    webMap: EsriWebMap,
  ): Promise<string> {
    const tileUrl = webMap.baseMap?.baseMapLayers?.[0]?.url;
    if (typeof tileUrl !== 'string' || tileUrl.length === 0) return '';
    const candidates = await this.prisma.item.findMany({
      where: { orgId: user.orgId, type: 'basemap', deletedAt: null },
      select: { id: true, data: true },
    });
    for (const c of candidates) {
      const url = (c.data as { tileUrl?: unknown } | null)?.tileUrl;
      if (typeof url === 'string' && url === tileUrl) return c.id;
    }
    return '';
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Translate an Esri operationalLayer URL into a portal MapLayer
 * source. Returns undefined for URLs we can't classify; callers
 * surface that as a per-layer warning.
 *
 * URL patterns recognised:
 *   - .../api/items/<id>/layers/<key>/geojson
 *                                -> data-layer (our own export)
 *   - .../api/items/<id>/layers/<key>/tile/{z}/{x}/{y}.mvt
 *                                -> data-layer (our own export)
 *   - .../FeatureServer/<n>      -> arcgis-rest, FeatureServer
 *   - .../MapServer/<n>          -> arcgis-rest, MapServer
 *   - .../{z}/{x}/{y}.pbf        -> arcgis-rest (vector tiles served
 *                                   live; v1 maps as a feature layer
 *                                   pointer for now)
 *   - *.geojson / *.json         -> geojson-url
 */
/**
 * Resolve an Esri operationalLayer URL against the AGO importer's
 * just-imported portal data_layers (#54/#55/#56 wave). The AGO
 * importer fills the lookup as it converts hosted Feature
 * Services into portal data_layer items; for every WebMap layer
 * URL of the form `<serviceUrl>/<agoLayerId>` we check whether
 * the service was one we just imported and, if so, point the new
 * MapLayer at the portal item directly.
 *
 * Returns null when:
 *   - the URL doesn't match the FeatureServer/MapServer + layer
 *     id shape (e.g. plain GeoJSON URLs, vector tile URLs)
 *   - the service URL isn't in the lookup (external service)
 *   - the service was imported but the specific AGO layer id
 *     wasn't (e.g. operator excluded one sublayer of a multi-
 *     layer service in the preview)
 *
 * The caller falls back to the legacy arcgis_service / geojson
 * paths when null is returned.
 */
function matchAgoDataLayerSource(
  sourceUrl: string,
  lookup: Map<
    string,
    { itemId: string; agoLayerIdToSublayerKey: Record<number, string> }
  >,
): MapLayer['source'] | null {
  const url = sourceUrl.trim();
  if (!url) return null;
  // Match the same FeatureServer/MapServer + integer sublayer
  // shape mapSourceFromUrl uses, so the two paths stay in sync.
  const m = url.match(/^(.*\/(?:FeatureServer|MapServer))\/(\d+)\/?$/i);
  if (!m) return null;
  const serviceRoot = m[1] as string;
  const agoLayerId = Number.parseInt(m[2] as string, 10);
  // Normalize the service root the same way the AGO importer
  // did when populating the lookup (lowercase, no trailing
  // sublayer / slash / query string). Inlined rather than
  // imported from import-ago/ to avoid a backwards module dep.
  const canonical = serviceRoot.replace(/\/\d+\/*(?:\?.*)?$/, '').toLowerCase();
  const hit = lookup.get(canonical) ?? lookup.get(serviceRoot.toLowerCase());
  if (!hit) return null;
  const layerKey = hit.agoLayerIdToSublayerKey[agoLayerId];
  if (!layerKey) return null;
  return {
    kind: 'data-layer',
    itemId: hit.itemId,
    layerKey,
  };
}

function mapSourceFromUrl(args: {
  url: string;
  renderKind: 'geojson' | 'mvt' | 'geojson_table' | 'scalar_json';
  arcgisByUrl: Map<string, string>;
}): MapLayer['source'] | null {
  const url = args.url.trim();
  if (url.length === 0) return null;

  // Portal per-sublayer endpoints, the exact URL shapes our own
  // exporter emits (see WebMapJsonContext in the engine). Recognized
  // first so a re-imported portal export lands as a portal-rooted
  // data-layer source instead of an opaque URL. The host part is
  // deliberately not checked: this service does not know the
  // portal's public origin(s) (proxies, custom domains), and the
  // path shape is distinctive enough that a false positive requires
  // a URL from another GratisGIS portal, where a local data-layer
  // reference is still the closest available meaning.
  const portalGeojson = url.match(
    /\/api\/items\/([^/]+)\/layers\/([^/]+)\/geojson(?:\?.*)?$/i,
  );
  if (portalGeojson) {
    return {
      kind: 'data-layer',
      itemId: portalGeojson[1] as string,
      layerKey: portalGeojson[2] as string,
    };
  }
  const portalTile = url.match(
    /\/api\/items\/([^/]+)\/layers\/([^/]+)\/tile\/\{z\}\/\{x\}\/\{y\}\.mvt$/i,
  );
  if (portalTile) {
    return {
      kind: 'data-layer',
      itemId: portalTile[1] as string,
      layerKey: portalTile[2] as string,
    };
  }

  // FeatureServer / MapServer with a layer-id suffix: parse it.
  const featureServer = url.match(/^(.*\/FeatureServer)\/(\d+)\/?$/i);
  if (featureServer) {
    const matchedItemId = args.arcgisByUrl.get(url);
    return {
      kind: 'arcgis-rest',
      url: featureServer[1] as string,
      layerId: Number.parseInt(featureServer[2] as string, 10),
      serviceType: 'FeatureServer',
      ...(matchedItemId !== undefined && { sourceItemId: matchedItemId }),
    };
  }
  const mapServer = url.match(/^(.*\/MapServer)\/(\d+)\/?$/i);
  if (mapServer) {
    const matchedItemId = args.arcgisByUrl.get(url);
    return {
      kind: 'arcgis-rest',
      url: mapServer[1] as string,
      layerId: Number.parseInt(mapServer[2] as string, 10),
      serviceType: 'MapServer',
      ...(matchedItemId !== undefined && { sourceItemId: matchedItemId }),
    };
  }

  // Plain GeoJSON URL.
  if (/\.(geo)?json(\?|$)/i.test(url)) {
    return { kind: 'geojson-url', url };
  }

  // Vector-tile URL pattern. Defer to a generic arcgis-rest
  // fall-through so something renders; richer support is a
  // future feature.
  if (/\{z\}\/\{[xy]\}\/\{[xy]\}\.pbf/i.test(url)) {
    return null; // unsupported in v1, surface as warning
  }

  return null;
}

function buildMapLayer(args: {
  lens: Omit<Lens, 'id'>;
  source: MapLayer['source'];
  /** Import-level warning sink for filter shapes we cannot carry. */
  warnings: string[];
}): MapLayer {
  // Stable layer id keeps round-trip metadata predictable. UUID
  // is overkill but we don't have a better counter handy.
  const id = `imported-${Math.random().toString(36).slice(2, 10)}`;
  // Try to lift the AGO renderer the engine stashed on
  // `lens.query.agoRenderer` (#71). When present, the simple-fill
  // / simple-marker / simple-line symbol is read off the renderer
  // and merged into the portal layer's style on top of the
  // default, so the imported map looks roughly like the AGO source
  // instead of every layer rendering as the same blue. Falls back
  // to the default style when the renderer is missing / not a
  // shape we understand.
  const agoRenderer = (args.lens.query as { agoRenderer?: unknown })
    .agoRenderer;
  const style = mergeAgoSymbolIntoStyle(defaultLayerStyle(), agoRenderer);
  // Everything not explicitly imported rides the shared DEFAULT_*
  // constants, spread into fresh objects (samples.service.ts is the
  // reference pattern). The previous hand-rolled literal here had
  // drifted from the MapLayer contract: it wrote fields no consumer
  // reads (interactions.hoverEffect, labels.expression) and omitted
  // declared ones (popup.mode, labels.template, search.labelTemplate),
  // so imported maps carried a shape no other surface produced.
  // Typing the literal as MapLayer makes that class of drift a
  // compile error.
  return {
    id,
    title: args.lens.name,
    visible: true,
    opacity: 1,
    source: args.source,
    style,
    renderer: { kind: 'simple' },
    popup: { ...DEFAULT_LAYER_POPUP },
    interactions: { ...DEFAULT_LAYER_INTERACTIONS },
    labels: { ...DEFAULT_LAYER_LABELS },
    search: { ...DEFAULT_LAYER_SEARCH },
    filter: mapLayerFilterFromLens(args.lens, args.warnings),
    scale: { ...DEFAULT_LAYER_SCALE },
    access: { ...DEFAULT_LAYER_ACCESS, entries: [] },
  };
}

/**
 * Carry the imported lens's single-clause attrFilter (parsed from
 * the WebMap's definitionExpression by the engine) onto the portal
 * MapLayer as a one-clause filter, completing the filter round trip
 * that the exporter starts in lensFromDataLayerSource. Operators
 * without a MapFilterOp equivalent (`in`, `startsWith`) surface as
 * an import warning and the layer imports unfiltered; MapFilterOp
 * values stay strings by contract (the viewer coerces at render
 * time), so numbers and booleans are stringified.
 */
function mapLayerFilterFromLens(
  lens: Omit<Lens, 'id'>,
  warnings: string[],
): MapLayerFilter | null {
  const f = lens.query.attrFilter;
  if (!f) return null;
  // `field = NULL` (an eq/neq against a NULL literal) never matches
  // as a SQL comparison; the author's intent is the null check, so
  // map it to the portal's is-null / is-not-null ops.
  if (f.value === null && (f.op === 'eq' || f.op === 'neq')) {
    return {
      combinator: 'all',
      clauses: [
        {
          field: f.field,
          op: f.op === 'eq' ? 'is-null' : 'is-not-null',
          value: '',
        },
      ],
    };
  }
  const opMap: Partial<Record<LensAttrFilter['op'], MapFilterOp>> = {
    eq: '==',
    neq: '!=',
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
    contains: 'contains',
    isNull: 'is-null',
    isNotNull: 'is-not-null',
  };
  const op = opMap[f.op];
  if (!op) {
    warnings.push(
      `Layer "${lens.name}": filter operator "${f.op}" has no portal equivalent; layer imported without its filter.`,
    );
    return null;
  }
  const value =
    op === 'is-null' || op === 'is-not-null' ? '' : String(f.value ?? '');
  return { combinator: 'all', clauses: [{ field: f.field, op, value }] };
}

/**
 * Approximate an Esri renderer's primary symbol on the portal
 * MapLayer style (#71). Only the simple renderer is honoured
 * end-to-end today: a uniqueValue or classBreaks renderer would
 * map to a portal "uniqueValue" or "classBreaks" MapLayer
 * renderer kind, which is out of scope for v1 of this lift.
 * For those, we still take the renderer's `defaultSymbol`
 * (when present) so the imported layer at least looks like
 * the majority class instead of falling back to plain blue.
 *
 * Esri symbol shapes recognised:
 *   - esriSFS  (Simple Fill Symbol)   -> polygon style
 *   - esriSLS  (Simple Line Symbol)   -> line style + polygon
 *                                        stroke
 *   - esriSMS  (Simple Marker Symbol) -> point style
 *
 * Colors arrive as RGBA arrays in 0-255 range; the portal style
 * stores hex RGB + a separate 0..1 opacity. We split them on the
 * way out. Anything missing / malformed leaves the style at
 * defaults.
 */
function mergeAgoSymbolIntoStyle(
  base: MapLayerStyle,
  renderer: unknown,
): MapLayerStyle {
  const sym = extractEsriSymbol(renderer);
  if (!sym) return base;
  const next: MapLayerStyle = JSON.parse(JSON.stringify(base));
  const type = (sym as { type?: string }).type;
  if (type === 'esriSFS') {
    const fill = rgbaToHexOpacity((sym as { color?: unknown }).color);
    if (fill) {
      next.polygon.fillColor = fill.hex;
      next.polygon.fillOpacity = fill.opacity;
    }
    const outline = (sym as { outline?: unknown }).outline;
    const outlineColor = rgbaToHexOpacity(
      (outline as { color?: unknown } | undefined)?.color,
    );
    if (outlineColor) next.polygon.strokeColor = outlineColor.hex;
    const outlineWidth = (outline as { width?: unknown } | undefined)?.width;
    if (typeof outlineWidth === 'number' && outlineWidth >= 0) {
      next.polygon.strokeWidth = outlineWidth;
    }
  } else if (type === 'esriSLS') {
    const stroke = rgbaToHexOpacity((sym as { color?: unknown }).color);
    if (stroke) {
      next.line.color = stroke.hex;
      next.polygon.strokeColor = stroke.hex;
    }
    const width = (sym as { width?: unknown }).width;
    if (typeof width === 'number' && width >= 0) {
      next.line.width = width;
      next.polygon.strokeWidth = width;
    }
  } else if (type === 'esriSMS') {
    const fill = rgbaToHexOpacity((sym as { color?: unknown }).color);
    if (fill) next.point.color = fill.hex;
    const size = (sym as { size?: unknown }).size;
    if (typeof size === 'number' && size > 0) {
      // Esri size is point diameter; portal radius is half that.
      next.point.radius = Math.max(1, Math.round(size / 2));
    }
    const outline = (sym as { outline?: unknown }).outline;
    const outlineColor = rgbaToHexOpacity(
      (outline as { color?: unknown } | undefined)?.color,
    );
    if (outlineColor) next.point.strokeColor = outlineColor.hex;
    const outlineWidth = (outline as { width?: unknown } | undefined)?.width;
    if (typeof outlineWidth === 'number' && outlineWidth >= 0) {
      next.point.strokeWidth = outlineWidth;
    }
    // Portal point symbol vocabulary is intentionally tiny right
    // now (circle / icon). Any Esri marker variant falls back to
    // "circle" so the layer at least renders with the right
    // color + size; richer marker shapes are a follow-up.
    next.point.symbol = 'circle';
  }
  return next;
}

/**
 * Walk an Esri renderer envelope and return the symbol the
 * imported layer should be styled with. Handles the three
 * common renderer shapes:
 *   - simple        -> renderer.symbol
 *   - uniqueValue   -> renderer.defaultSymbol or first uniqueValueInfo
 *   - classBreaks   -> renderer.defaultSymbol or first classBreakInfo
 */
function extractEsriSymbol(renderer: unknown): unknown {
  if (!renderer || typeof renderer !== 'object') return null;
  const r = renderer as Record<string, unknown>;
  if (r.symbol) return r.symbol;
  if (r.defaultSymbol) return r.defaultSymbol;
  const infos = r.uniqueValueInfos ?? r.classBreakInfos;
  if (Array.isArray(infos) && infos.length > 0) {
    const first = infos[0] as { symbol?: unknown };
    if (first?.symbol) return first.symbol;
  }
  return null;
}

/**
 * Convert an Esri RGBA color (`[r, g, b, a]`, each 0-255 except
 * a which is 0-255) into a `{ hex, opacity }` pair where hex is
 * the portal style's `#rrggbb` and opacity is a 0..1 float.
 * Returns null for malformed input so the caller leaves the
 * default style intact.
 */
function rgbaToHexOpacity(
  color: unknown,
): { hex: string; opacity: number } | null {
  if (!Array.isArray(color) || color.length < 3) return null;
  const [r, g, b, a] = color as number[];
  if (
    typeof r !== 'number' ||
    typeof g !== 'number' ||
    typeof b !== 'number'
  ) {
    return null;
  }
  const clamp = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));
  const hex =
    '#' +
    [clamp(r), clamp(g), clamp(b)]
      .map((n) => n.toString(16).padStart(2, '0'))
      .join('');
  const opacity = typeof a === 'number' ? clamp(a) / 255 : 1;
  return { hex, opacity };
}

function defaultLayerStyle(): MapLayerStyle {
  // Fresh per-section copies of the shared default style. This
  // replaced a locally-drifted style literal: the shared default is
  // the single source of truth for "what a layer looks like with no
  // styling information" (its polygon values already carry the
  // visible-on-any-basemap tuning from #70), and the copies keep
  // mergeAgoSymbolIntoStyle's mutation of the returned object from
  // ever writing back into the module-level constant.
  return {
    point: { ...DEFAULT_LAYER_STYLE.point },
    line: { ...DEFAULT_LAYER_STYLE.line },
    polygon: { ...DEFAULT_LAYER_STYLE.polygon },
  };
}

function guessTitle(webMap: EsriWebMap): string {
  if (webMap.authoringApp && webMap.authoringApp !== 'GratisGIS') {
    return `${webMap.authoringApp} import`;
  }
  return '';
}

// `LensView` is referenced by the engine; re-export so the
// controller signature can quote it without a separate import.
export type { LensView };
