// SPDX-License-Identifier: AGPL-3.0-or-later
import type { StyleSpecification } from 'maplibre-gl';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import type { PMTiles } from 'pmtiles';
// maplibre-cog-protocol 0.8 (the maplibre-gl@5 build) switched from
// a default export to a named export; the function itself is the
// same shape.
import { cogProtocol } from '@geomatico/maplibre-cog-protocol';
import type { BasemapData } from '@gratis-gis/shared-types';

// Register the pmtiles:// AND cog:// protocols with MapLibre
// once per page load.
//
//   pmtiles://  (#179) Range-serves PMTiles archives stored in
//               MinIO via the api proxy endpoint.  Powers every
//               tile_layer item whose `format` is 'pmtiles'.
//
//   cog://      Range-serves Cloud-Optimized GeoTIFFs via the
//               same api proxy endpoint.  Powers tile_layer
//               items in the 'cog' bridge state (raw raster
//               uploads waiting on the PMTiles pyramid worker)
//               and stays valid even after the pyramid lands so
//               an older saved view still resolves.
//
// The protocol registry is global state on the maplibregl singleton,
// shared with every other map surface, so this module cannot assume it
// still holds whatever it wrote earlier. See the #209 note in
// map-canvas: a cached "already registered" flag outlived the
// registration itself and permanently hid the missing scheme. Re-assert
// on every call instead of guarding; the PMTiles instance is kept
// module-level so its archive header cache survives the repeats.
let pmtilesProtocol: Protocol | null = null;

/**
 * Register the pmtiles:// and cog:// protocols on the MapLibre
 * singleton. Idempotent and safe to call from every map mount.
 * Each scheme registers independently inside its own try/catch so a
 * failure loading one plugin never blocks the other.
 *
 * Call this explicitly at map init, BEFORE the map adds any pmtiles
 * or cog source. It used to run only as a bare module-load side
 * effect, which worked while this module shared a client chunk with
 * the map. A Next build (16.2.x) split it into a separate chunk that
 * no longer executed before the map created its raster sources, so
 * every tile fetch threw "URL scheme pmtiles is not supported" and no
 * raster overlay or DEM-draped terrain drew (#209). An explicit call
 * runs in the map's own code path, independent of chunk splitting.
 */
export function ensureRasterProtocols(): void {
  // addProtocol touches the browser-only maplibregl singleton; skip
  // during SSR, where there is no registry to write to.
  if (typeof window === 'undefined') return;
  try {
    if (!pmtilesProtocol) pmtilesProtocol = new Protocol();
    maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('failed to register the pmtiles:// map protocol', err);
  }
  try {
    // The @geomatico plugin exports the handler as the function
    // itself. MapLibre's addProtocol() typings disagree on the
    // handler shape across versions, hence the unknown cast.
    // Separate try/catch so one broken plugin cannot block the other.
    maplibregl.addProtocol(
      'cog',
      cogProtocol as unknown as Parameters<typeof maplibregl.addProtocol>[1],
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('failed to register the cog:// map protocol', err);
  }
}

/**
 * Register a local PMTiles archive on the shared protocol instance,
 * so `pmtiles://<archive name>` in a style resolves to it.
 *
 * This exists because there must be exactly ONE Protocol instance
 * behind the scheme. The 2026-08-24 review found three writers: this
 * module, a private twin inside map-canvas, and the offline-basemap
 * module swapping in a fresh instance per call. Only the fresh one
 * knew about the local archive, and map-canvas re-asserts its own on
 * every overlay sync, so the offline basemap went blank the moment a
 * map with a tile overlay synced its layers. Adding archives to the
 * one shared instance, instead of replacing the handler, is the fix:
 * re-assertion by any caller keeps serving everyone's archives.
 */
export function registerPmtilesArchive(archive: PMTiles): void {
  ensureRasterProtocols();
  pmtilesProtocol?.add(archive);
}

// Best-effort registration at module load for any importer that
// renders a pmtiles/cog source without calling ensureRasterProtocols
// first. The reliable path is the explicit call at map init (see the
// doc above); this is only a backstop.
ensureRasterProtocols();

/**
 * Shape of a custom basemap row coming back from /api/basemaps.
 * Mirrors the Prisma Basemap model; duplicated here to keep the
 * web package free of a @prisma/client build-time dep.
 */
export interface CustomBasemap {
  id: string;
  orgId: string;
  label: string;
  description: string;
  url: string;
  sourceKind: 'xyz' | 'vector-style' | 'wms';
  attribution: string;
  thumbnailUrl: string | null;
  config: Record<string, unknown> | null;
  isDefault: boolean;
}

// Same public glyph endpoint the built-in raster basemaps use. Swap
// for a self-hosted font pack in production deployments.
const DEFAULT_GLYPHS =
  'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf';

/**
 * Turn a custom basemap row into a MapLibre StyleSpecification that
 * can be passed to map.setStyle(). Three source kinds supported:
 *
 *   xyz          raster tile template with {z}/{x}/{y} placeholders
 *   vector-style a style.json URL we hand to MapLibre directly
 *   wms          raster over WMS GetMap; needs layers/format/CRS in
 *                the row's `config` JSON
 *
 * For `vector-style` we return a sentinel that the caller (MapCanvas)
 * handles specially: MapLibre's setStyle() accepts a URL string in
 * addition to a StyleSpecification, so we use the string form to let
 * it fetch and parse the JSON itself.
 */
export type CustomStyle =
  | { kind: 'inline'; style: StyleSpecification }
  | { kind: 'url'; url: string };

export function customBasemapToStyle(b: CustomBasemap): CustomStyle {
  if (b.sourceKind === 'vector-style') {
    return { kind: 'url', url: b.url };
  }

  if (b.sourceKind === 'xyz') {
    // #179: pmtiles:// URLs use a different source shape. The
    // pmtiles protocol returns a tile-JSON document when given
    // the source `url` (no {z}/{x}/{y} template substitution),
    // so we emit `url` instead of `tiles`. Both raster and
    // vector PMTiles caches can land here; the inner content
    // type is signalled by the cache file itself so we default
    // to raster (the common basemap case). Vector pmtiles
    // basemaps need their source-layer + style configured by
    // the author and are out of v1 scope here -- the user
    // would instead use a style.json (the 'vector-style' path).
    if (b.url.startsWith('pmtiles://') || b.url.startsWith('cog://')) {
      return {
        kind: 'inline',
        style: {
          version: 8,
          glyphs: DEFAULT_GLYPHS,
          sources: {
            raster: {
              type: 'raster',
              url: b.url,
              tileSize: 256,
              attribution: b.attribution || undefined,
            },
          },
          layers: [
            { id: 'raster-layer', type: 'raster', source: 'raster' },
          ],
        } as StyleSpecification,
      };
    }
    return {
      kind: 'inline',
      style: {
        version: 8,
        glyphs: DEFAULT_GLYPHS,
        sources: {
          raster: {
            type: 'raster',
            tiles: [b.url],
            tileSize: 256,
            attribution: b.attribution || undefined,
          },
        },
        layers: [{ id: 'raster-layer', type: 'raster', source: 'raster' }],
      } as StyleSpecification,
    };
  }

  // WMS: we treat the URL as the GetMap base and compose a tile URL
  // with the standard WMS 1.1.1 / 1.3.0 parameters. Callers populate
  // `config` with `layers` (required), plus optional `format`,
  // `transparent`, `version`, `styles`, `crs`.
  const cfg = (b.config ?? {}) as Record<string, unknown>;
  const layers = typeof cfg.layers === 'string' ? cfg.layers : '';
  const format = typeof cfg.format === 'string' ? cfg.format : 'image/png';
  const transparent =
    cfg.transparent === true || cfg.transparent === 'true' ? 'TRUE' : 'FALSE';
  const version = typeof cfg.version === 'string' ? cfg.version : '1.3.0';
  const styles = typeof cfg.styles === 'string' ? cfg.styles : '';
  const crs = typeof cfg.crs === 'string' ? cfg.crs : 'EPSG:3857';
  const bboxParam = version.startsWith('1.3')
    ? '{bbox-epsg-3857}'
    : '{bbox-epsg-3857}';
  const tileUrl = buildWmsTileUrl(b.url, {
    SERVICE: 'WMS',
    VERSION: version,
    REQUEST: 'GetMap',
    LAYERS: layers,
    STYLES: styles,
    FORMAT: format,
    TRANSPARENT: transparent,
    [version.startsWith('1.3') ? 'CRS' : 'SRS']: crs,
    WIDTH: '256',
    HEIGHT: '256',
    BBOX: bboxParam,
  });

  return {
    kind: 'inline',
    style: {
      version: 8,
      glyphs: DEFAULT_GLYPHS,
      sources: {
        raster: {
          type: 'raster',
          tiles: [tileUrl],
          tileSize: 256,
          attribution: b.attribution || undefined,
        },
      },
      layers: [{ id: 'raster-layer', type: 'raster', source: 'raster' }],
    } as StyleSpecification,
  };
}

/**
 * Adapter: project a legacy `CustomBasemap` row onto the v1
 * `BasemapData` shape so callers can hand either form to the
 * shared BasemapPreview component.  The two shapes are isomorphic
 * for our purposes; just different field names.
 */
export function customBasemapToData(b: CustomBasemap): BasemapData {
  const attribution = b.attribution || undefined;
  if (b.sourceKind === 'vector-style') {
    return {
      version: 1,
      kind: 'style-url',
      styleUrl: b.url,
      ...(attribution ? { attribution } : {}),
    };
  }
  if (b.sourceKind === 'xyz') {
    return {
      version: 1,
      kind: 'tile-url',
      tileUrl: b.url,
      ...(attribution ? { attribution } : {}),
    };
  }
  // wms
  const cfg = (b.config ?? {}) as Record<string, unknown>;
  return {
    version: 1,
    kind: 'wms',
    wmsUrl: b.url,
    wmsConfig: {
      layers: typeof cfg.layers === 'string' ? cfg.layers : '',
      ...(typeof cfg.format === 'string' ? { format: cfg.format } : {}),
      ...(cfg.transparent === true || cfg.transparent === 'true'
        ? { transparent: true }
        : {}),
      ...(typeof cfg.version === 'string' ? { version: cfg.version } : {}),
      ...(typeof cfg.styles === 'string' ? { styles: cfg.styles } : {}),
      ...(typeof cfg.crs === 'string' ? { crs: cfg.crs } : {}),
    },
    ...(attribution ? { attribution } : {}),
  };
}

/**
 * Convert a BasemapData blob (the shape stored on a basemap ITEM) to
 * the same CustomStyle the legacy CustomBasemap path produces.
 * Lets the BasemapPreview component and any other surface that has
 * an item.data in hand render through one renderer (#67).
 *
 * Returns null when the blob doesn't yet have a URL for its kind
 * (e.g. a brand-new basemap being authored); callers render an
 * empty-state placeholder instead of trying to mount MapLibre
 * against undefined.
 */
export function basemapDataToStyle(d: BasemapData): CustomStyle | null {
  if (d.kind === 'style-url') {
    if (!d.styleUrl) return null;
    return { kind: 'url', url: d.styleUrl };
  }
  if (d.kind === 'tile-url') {
    if (!d.tileUrl) return null;
    if (d.tileUrl.startsWith('pmtiles://')) {
      return {
        kind: 'inline',
        style: {
          version: 8,
          glyphs: DEFAULT_GLYPHS,
          sources: {
            raster: {
              type: 'raster',
              url: d.tileUrl,
              tileSize: 256,
              attribution: d.attribution || undefined,
            },
          },
          layers: [{ id: 'raster-layer', type: 'raster', source: 'raster' }],
        } as StyleSpecification,
      };
    }
    if (d.tileUrl.startsWith('cog://')) {
      // cog:// URLs are handled by the @geomatico cog protocol
      // plugin registered at module load.  MapLibre treats this
      // as a raster source whose `url` returns a tile-json shape;
      // the plugin synthesizes one from the COG's header.
      return {
        kind: 'inline',
        style: {
          version: 8,
          glyphs: DEFAULT_GLYPHS,
          sources: {
            raster: {
              type: 'raster',
              url: d.tileUrl,
              tileSize: 256,
              attribution: d.attribution || undefined,
            },
          },
          layers: [{ id: 'raster-layer', type: 'raster', source: 'raster' }],
        } as StyleSpecification,
      };
    }
    return {
      kind: 'inline',
      style: {
        version: 8,
        glyphs: DEFAULT_GLYPHS,
        sources: {
          raster: {
            type: 'raster',
            tiles: [d.tileUrl],
            tileSize: 256,
            attribution: d.attribution || undefined,
          },
        },
        layers: [{ id: 'raster-layer', type: 'raster', source: 'raster' }],
      } as StyleSpecification,
    };
  }
  if (d.kind === 'wms') {
    if (!d.wmsUrl || !d.wmsConfig?.layers) return null;
    const cfg = d.wmsConfig;
    const format = cfg.format ?? 'image/png';
    const transparent = cfg.transparent === true ? 'TRUE' : 'FALSE';
    const version = cfg.version ?? '1.3.0';
    const styles = cfg.styles ?? '';
    const crs = cfg.crs ?? 'EPSG:3857';
    const tileUrl = buildWmsTileUrl(d.wmsUrl, {
      SERVICE: 'WMS',
      VERSION: version,
      REQUEST: 'GetMap',
      LAYERS: cfg.layers,
      STYLES: styles,
      FORMAT: format,
      TRANSPARENT: transparent,
      [version.startsWith('1.3') ? 'CRS' : 'SRS']: crs,
      WIDTH: '256',
      HEIGHT: '256',
      BBOX: '{bbox-epsg-3857}',
    });
    return {
      kind: 'inline',
      style: {
        version: 8,
        glyphs: DEFAULT_GLYPHS,
        sources: {
          raster: {
            type: 'raster',
            tiles: [tileUrl],
            tileSize: 256,
            attribution: d.attribution || undefined,
          },
        },
        layers: [{ id: 'raster-layer', type: 'raster', source: 'raster' }],
      } as StyleSpecification,
    };
  }
  // composed-map (Phase 2 placeholder) not yet rendered.
  return null;
}

/**
 * Preserve any query string already on the WMS base URL and append
 * the standard parameters. WMS servers are historically picky about
 * case; upper-case keys are the safe common denominator.
 */
function buildWmsTileUrl(
  base: string,
  params: Record<string, string>,
): string {
  const hasQuery = base.includes('?');
  const separator = hasQuery ? '&' : '?';
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeWmsParam(v)}`)
    .join('&');
  return `${base}${separator}${qs}`;
}

/**
 * MapLibre's bbox placeholder already includes braces, so we should
 * NOT url-encode it: encoding would break the substitution. Every
 * other value is safe to encodeURIComponent.
 */
function encodeWmsParam(v: string): string {
  if (v.startsWith('{bbox-')) return v;
  return encodeURIComponent(v);
}
