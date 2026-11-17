// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Cache-Control for an authorizing byte proxy (tile archives, point
 * clouds, DEM tiles) on a route that serves both anonymous and
 * signed-in callers.
 *
 * A signed-in caller may be reading an item that is shared to them
 * and not public, so the response is `private`: a shared proxy or CDN
 * must not hand it to the next caller. An anonymous caller only ever
 * resolves public items, so `public` is safe there and lets a CDN
 * absorb the range-request storm.
 */
export function byteProxyCacheControl(
  user: unknown,
  maxAgeSeconds: number,
  opts: { immutable?: boolean } = {},
): string {
  const scope = user ? 'private' : 'public';
  return `${scope}, max-age=${maxAgeSeconds}${opts.immutable ? ', immutable' : ''}`;
}
