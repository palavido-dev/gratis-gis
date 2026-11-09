// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Request } from 'express';

/**
 * Label helpers for the HTTP metrics. Every value they return comes
 * from a fixed set or from a route template written in the source, so
 * the number of series is bounded by the number of routes. A raw path,
 * a query string, an item id, a layer name or a user name can never
 * become a label value.
 */

const KNOWN_METHODS = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

/** Route label for a request that matched no route (404s, probes). */
export const UNMATCHED_ROUTE = 'unmatched';

export function methodLabel(method: string | undefined): string {
  const upper = (method ?? '').toUpperCase();
  return KNOWN_METHODS.has(upper) ? upper : 'OTHER';
}

export function statusClassLabel(status: number): string {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    return 'unknown';
  }
  return `${Math.floor(status / 100)}xx`;
}

/**
 * The route template Express matched, such as
 * `/api/items/:id`. Express sets `req.route` once a route handler is
 * chosen; requests that never reach one (unknown paths, a middleware
 * that answered first) get UNMATCHED_ROUTE, and so does Nest's own
 * catch-all not-found route (`*path`), which every unknown path hits.
 * Only `req.route.path` is read: `req.originalUrl`, `req.path` and
 * `req.baseUrl` all carry the caller's values and are never used.
 */
export function routeTemplate(req: Pick<Request, 'route'>): string {
  const path: unknown = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof path !== 'string' || path.length === 0) return UNMATCHED_ROUTE;
  // A template that is nothing but a wildcard matches everything.
  if (/^\/?\*/.test(path)) return UNMATCHED_ROUTE;
  return path;
}

export type TileKind = 'vector' | 'raster';
export type TileSurface = 'public' | 'portal';

/**
 * Which tile family a route template serves, or null for a route that
 * does not serve tiles. Classified from the template so no tile
 * controller has to change: MVT routes end in `.mvt`, the OGC API
 * Tiles route ends in its tile matrix triple, and raster tiles come
 * from tile_layer pyramids and the elevation mosaic.
 */
export function tileKindOf(template: string): TileKind | null {
  if (/\/:z\/:x\/:y\.mvt$/.test(template)) return 'vector';
  if (/\/tiles\/:tmsId\/:tileMatrix\/:tileRow\/:tileCol$/.test(template)) {
    return 'vector';
  }
  if (/\/tile-layer\/:itemId\/tiles\/:z\/:x\/:y(\.png)?$/.test(template)) {
    return 'raster';
  }
  if (/\/elevation-mosaic\/:z\/:x\/:y\.png$/.test(template)) return 'raster';
  return null;
}

export function tileSurfaceOf(template: string): TileSurface {
  return template.startsWith('/api/public/') ? 'public' : 'portal';
}
