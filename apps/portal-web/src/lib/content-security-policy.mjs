// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Document policy for portal pages. Shared by next.config.mjs and the
 * portal-api BFF route, which sets it itself (see PAGE_CSP_SOURCE).
 *
 * `script-src-attr 'none'` refuses inline event handlers. Next and
 * MapLibre still need inline scripts, eval for some WASM loaders,
 * and blob workers, so `script-src` stays loose on purpose.
 * Tile and imagery hosts are chosen by the map author and may be
 * plain HTTP on a LAN, so images and connections allow http and
 * https rather than a host list.
 */
export const PAGE_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  "media-src 'self' blob: https: http:",
  "connect-src 'self' https: http: ws: wss: blob: data:",
  "worker-src 'self' blob:",
  "frame-src 'self' blob:",
].join('; ');

/**
 * next.config `headers()` source for PAGE_CSP: every path except the
 * BFF under /api/portal/. Next drops a route handler's header when the
 * config already set one of the same name, so a config CSP on the BFF
 * would silently replace the stricter policy portal-api sends with a
 * proxied document. The BFF applies PAGE_CSP itself whenever the
 * upstream sends none.
 */
export const PAGE_CSP_SOURCE = '/:path((?!api/portal/).*)';
