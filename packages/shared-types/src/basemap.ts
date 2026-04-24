/**
 * Basemap item payload. Basemaps are first-class items (Phase 1a of
 * the basemap refactor, task #72) so they participate in sharing,
 * dependency tracking, ownership, provenance, and housekeeping like
 * any other item.
 *
 * The `kind` discriminator mirrors how MapLibre consumes the source:
 *
 *   style-url    a hosted MapLibre style.json URL; MapLibre fetches
 *                and parses it directly.
 *   tile-url     a raster XYZ tile template (`{z}/{x}/{y}`). Rendered
 *                by composing a minimal style inline.
 *   wms          a WMS GetMap base URL. Needs layers / format / CRS
 *                metadata carried in `wmsConfig` to compose a request.
 *   composed-map (Phase 2, task #73) a reference to another map item
 *                that is served through a composed style endpoint.
 *                Not produced yet in Phase 1a; the migration does not
 *                emit this kind.
 *
 * Only the fields matching the active `kind` are meaningful; the rest
 * should be absent or left empty. Callers that need a strict decode
 * should use a discriminated union rather than reading this interface
 * directly.
 */
export type BasemapKind = 'style-url' | 'tile-url' | 'wms' | 'composed-map';

export type BasemapDataVersion = 1;

export interface BasemapWmsConfig {
  /** Comma-separated WMS layer names (required). */
  layers: string;
  /** Output format, defaults to `image/png`. */
  format?: string;
  /** Whether the WMS should return transparent tiles. */
  transparent?: boolean;
  /** WMS protocol version, defaults to `1.3.0`. */
  version?: string;
  /** Optional styles parameter. */
  styles?: string;
  /** Coordinate reference system, defaults to `EPSG:3857`. */
  crs?: string;
}

export interface BasemapData {
  version: BasemapDataVersion;
  kind: BasemapKind;
  /** For `style-url`: MapLibre style.json URL. */
  styleUrl?: string;
  /** For `tile-url`: XYZ raster tile template. */
  tileUrl?: string;
  /** For `wms`: GetMap base URL; see `wmsConfig` for params. */
  wmsUrl?: string;
  wmsConfig?: BasemapWmsConfig;
  /** For `composed-map` (Phase 2): target map item UUID. */
  mapItemId?: string;
  attribution?: string;
  thumbnailUrl?: string;
}

export const DEFAULT_BASEMAP: BasemapData = {
  version: 1,
  kind: 'tile-url',
};

export function isBasemapData(value: unknown): value is BasemapData {
  if (!value || typeof value !== 'object') return false;
  const v = value as { version?: unknown; kind?: unknown };
  if (v.version !== 1) return false;
  return (
    v.kind === 'style-url' ||
    v.kind === 'tile-url' ||
    v.kind === 'wms' ||
    v.kind === 'composed-map'
  );
}
