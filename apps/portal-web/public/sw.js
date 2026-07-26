// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * GratisGIS Service Worker
 *
 * Caching strategy:
 *   - Static assets (JS, CSS, fonts, images): Cache-first with background revalidation.
 *   - GeoJSON feature data (/api/portal/items/:id/geojson and the v3
 *     per-layer /api/portal/items/:id/layers/:key/geojson): Network-first with
 *     cache fallback so maps render offline with the last-seen dataset.
 *   - Other portal-api reads (/api/portal/*): Network-first with no offline fallback
 *     (these need fresh auth tokens and change frequently).
 *   - Sign-out: the page posts 'gg:clear-user-caches' and the worker drops the
 *     tile + geojson caches, since both hold auth-gated org data.
 *
 * Offline feature WRITES are not this worker's job: they queue in the
 * 'gratisgis-offline' IndexedDB (lib/offline-store.ts) and drain from the
 * main thread via lib/offline-sync.ts.
 *
 * Versioning: bump CACHE_VERSION on every deploy so stale assets are evicted.
 */

// v5: widen the geojson cache pattern to the v3 per-layer shape and
// purge user caches on sign-out; bumping rotates every runtime cache
// so entries written under the old rules don't linger.
// (v4 evicted static caches that predate deploymentId-based asset
// URLs: Turbopack reuses chunk filenames across builds, so the ?dpl=
// query on asset URLs is what keeps each deploy's entries distinct.)
const CACHE_VERSION = 'v5';
const STATIC_CACHE = `gratis-static-${CACHE_VERSION}`;
const GEOJSON_CACHE = `gratis-geojson-${CACHE_VERSION}`;
// Slice 10: basemap + reference tiles. Keyed separately from static
// assets so the eviction policy can differ (tiles are large + we
// retain them aggressively for offline; static assets churn with
// every deploy and rotate via CACHE_VERSION).
const TILES_CACHE = `gratis-tiles-${CACHE_VERSION}`;
// Bucket for the offline catalog shell at /field. Pre-cached at SW
// install so the back-arrow from a field deployment always lands
// somewhere usable, online or not.
const SHELL_CACHE = `gratis-shell-${CACHE_VERSION}`;
const FIELD_OFFLINE_SHELL = '/field/offline.html';

// Detect the Next.js dev server. Dev chunks under /_next/static/ reuse
// filenames across restarts, so cache-first serves up stale JS whose
// module IDs no longer exist in the current webpack runtime, and that
// produces the dreaded `options.factory undefined` crash. Short-
// circuit static asset caching when running on localhost so dev is
// always fresh. The SwRegistrar should prevent this SW from loading
// in dev at all, but this guard handles the case where an older SW
// from a prior session is still running.
const IS_DEV_HOST =
  self.location.hostname === 'localhost' ||
  self.location.hostname === '127.0.0.1' ||
  self.location.hostname.endsWith('.local') ||
  self.location.hostname.endsWith('.localhost');

// Next.js static assets are served from /_next/static/. NOTE: with
// Turbopack the FILENAMES are reused across builds, so these are only
// safe to cache forever because next.config's deploymentId appends a
// per-deploy ?dpl= query to every asset URL (cache entries are keyed
// by full URL including query).
const STATIC_PATTERNS = [
  /^\/_next\/static\//,
  /^\/fonts\//,
  /\.(?:png|jpg|jpeg|svg|ico|webp|woff2?)$/,
];

// Matches both the legacy item-level shape (/items/:id/geojson) and
// the v3 per-layer shape (/items/:id/layers/:key/geojson) so multi-
// layer data layers get the same offline fallback as legacy items.
const GEOJSON_PATTERN = /\/api\/portal\/items\/[^/]+(?:\/layers\/[^/]+)?\/geojson/;

/**
 * Tile URL patterns. Catches the conventions every basemap provider
 * we ship today follows:
 *
 *   - XYZ raster: ends in /{z}/{x}/{y}.{png|jpg|jpeg|webp}
 *   - Vector tiles: ends in /{z}/{x}/{y}.{pbf|mvt} (with optional
 *     query string for tokens)
 *   - WMS GetMap responses: contain ?REQUEST=GetMap or &REQUEST=GetMap
 *     in the query string. Cache hit rate is low (URLs vary per bbox)
 *     but caching them at all means a worker who pans back over an
 *     area gets it instantly the second time.
 *   - MapLibre style.json fetches: end in /style.json (or are returned
 *     by a style URL), one-shot at runtime startup; caching protects
 *     against a flaky load.
 *
 * We deliberately don't try to cache GeoJSON tiles here -- the
 * GEOJSON_PATTERN above already handles our portal's feature endpoints.
 */
const TILE_PATH_PATTERN = /\/\d+\/\d+\/\d+(?:[@.][^/?]*)?(?:\.(?:png|jpe?g|webp|pbf|mvt))?(?:$|\?)/i;
const TILE_QUERY_PATTERN = /[?&]request=getmap\b/i;
const STYLE_JSON_PATTERN = /\/style\.json(?:$|\?)/i;

function isTileRequest(url) {
  if (TILE_PATH_PATTERN.test(url.pathname)) return true;
  if (TILE_QUERY_PATTERN.test(url.search)) return true;
  if (STYLE_JSON_PATTERN.test(url.pathname)) return true;
  return false;
}

// -------------------------------------------------------------------------
// Install: pre-cache the field offline shell so the back arrow from
// a field deployment always lands on something usable, even when
// offline. Other static assets are populated lazily via cacheFirst.
// -------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // cache.addAll bails the whole install if any URL fails. The
      // offline shell is a single static file so this is fine; if
      // it's missing the install fails fast and the SW falls back
      // to the previous version.
      cache.addAll([FIELD_OFFLINE_SHELL]).catch(() => {
        // Best-effort: don't kill SW install if the shell fetch
        // fails (dev mode 404, etc). The fallback handler below
        // tries to read it anyway -- worst case the user sees the
        // browser's offline screen.
      }),
    ),
  );
  // Skip waiting so the new SW activates immediately on the next navigate.
  self.skipWaiting();
});

// -------------------------------------------------------------------------
// Activate: clean up old caches.
// -------------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  const keep = new Set([STATIC_CACHE, GEOJSON_CACHE, TILES_CACHE, SHELL_CACHE]);
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)),
      ),
    ).then(() => self.clients.claim()),
  );
});

// -------------------------------------------------------------------------
// Fetch: intercept and apply caching strategy.
// -------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Tile caching applies to BOTH same-origin and cross-origin
  // requests. Most basemap providers (OSM, Carto, vector tile
  // services) are cross-origin; if we filtered to same-origin we'd
  // never cache the actual tiles a worker needs offline. We're
  // permissive here on purpose -- the URL pattern is restrictive
  // enough that we don't accidentally cache other people's APIs.
  if (request.method === 'GET' && isTileRequest(url)) {
    event.respondWith(tileCacheFirst(request));
    return;
  }

  // Only intercept same-origin requests beyond this point. Third-
  // party fetches that aren't tiles (auth flows, telemetry, etc.)
  // pass through unmodified.
  if (url.origin !== self.location.origin) return;

  // Field catalog navigation. The /field page is server-rendered
  // and needs network + auth to load, so without a fallback the
  // back arrow from an offline field deployment lands on a
  // browser "no internet" page. Network-first, fallback to the
  // pre-cached static shell at /field/offline.html. The shell
  // hydrates from IndexedDB so the user sees their cached
  // deployments and can re-enter one.
  if (
    request.mode === 'navigate' &&
    (url.pathname === '/field' ||
      url.pathname === '/field/' ||
      url.pathname.startsWith('/field?'))
  ) {
    event.respondWith(fieldNavigateWithFallback(request));
    return;
  }

  // GeoJSON: network-first with cache fallback (enables offline map rendering).
  if (GEOJSON_PATTERN.test(url.pathname)) {
    event.respondWith(networkFirstWithCache(request, GEOJSON_CACHE));
    return;
  }

  // Static assets: cache-first in prod (content-addressed), pass-through
  // in dev (chunk filenames aren't stable across dev server restarts).
  if (STATIC_PATTERNS.some((p) => p.test(url.pathname))) {
    if (IS_DEV_HOST) return;
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // Everything else: pass through to the network. This includes auth flows
  // and API mutations which must be fresh.
});

/**
 * Listen for cache-management messages from the main thread. The
 * tile-warmer module fires these during offline area downloads so
 * the SW can confirm pre-fetches landed and report progress.
 */
self.addEventListener('message', (event) => {
  // Reject cross-origin messages. Pages on a different origin shouldn't
  // be able to drive cache-management actions on our SW.  Browsers
  // already scope a SW to its registering origin, but a defensive
  // origin compare keeps a misbehaving extension / nested iframe from
  // sneaking in (CodeQL js/missing-origin-check).
  if (event.origin && event.origin !== self.location.origin) return;
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'tile-cache-stats') {
    void tileCacheStats().then((stats) => {
      event.ports[0]?.postMessage(stats);
    });
    return;
  }
  if (data.type === 'tile-cache-clear') {
    void caches.delete(TILES_CACHE).then(() => {
      event.ports[0]?.postMessage({ ok: true });
    });
    return;
  }
  if (data.type === 'gg:clear-user-caches') {
    // Sign-out hook. The tile and geojson caches hold auth-gated
    // portal responses (MVT tiles, per-layer geojson) fetched with
    // the departing user's session; left in place, the next person
    // on a shared machine could read that org data straight out of
    // cache without ever signing in. Static assets and the offline
    // shell carry no user data, so they survive. The sender waits
    // for the ack (with a timeout) before navigating to Keycloak.
    void Promise.all([
      caches.delete(TILES_CACHE),
      caches.delete(GEOJSON_CACHE),
    ]).then(() => {
      event.ports[0]?.postMessage({ ok: true });
    });
    return;
  }
});

// NOTE: this worker used to register a Background Sync handler that
// replayed a 'sync_queue' store from the 'gratis-gis' IndexedDB.
// Nothing ever wrote to that queue (its producer, lib/sync.ts
// queueFeatureWrite, had no callers), so the handler promised a
// sync that could never happen. The real offline write queue lives
// in the 'gratisgis-offline' IndexedDB (lib/offline-store.ts) and
// is drained from the main thread by lib/offline-sync.ts.

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    cache.put(request, response.clone());
  }
  return response;
}

/**
 * Cache-first strategy for tiles. Tiles change rarely; serving from
 * cache is correct almost always and dramatically faster on cellular.
 * On a cache miss we fetch + populate so subsequent visits are
 * instantaneous. On a cache miss + network failure (offline) we
 * return a 504 so MapLibre paints the missing-tile placeholder
 * rather than waiting indefinitely.
 *
 * Cross-origin tiles require special care: we must not throw away
 * opaque responses (response.ok is false for cross-origin no-cors,
 * but the response is still cacheable + usable by MapLibre). We
 * cache any non-error response we receive.
 */
async function tileCacheFirst(request) {
  const cache = await caches.open(TILES_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    // Cache 200s and opaque (cross-origin no-cors) responses. Don't
    // cache 4xx/5xx -- a 404 tile shouldn't poison the cache.
    if (response && (response.ok || response.type === 'opaque')) {
      // Clone before put: response body can only be consumed once.
      cache.put(request, response.clone()).catch(() => {
        /* quota exhaustion or storage failure -- ignore, the live
           response still flows through to MapLibre */
      });
    }
    return response;
  } catch {
    // Offline + no cache. Return a 504 so MapLibre's tile-error
    // handler renders the placeholder rather than retrying forever.
    return new Response('', {
      status: 504,
      statusText: 'Tile not in cache',
    });
  }
}

/**
 * Aggregate stats for the tile cache. Used by the field UI's
 * storage panel to surface "X tiles cached, Y MB" alongside the
 * IndexedDB usage. Iterating the cache keys is O(N tile entries);
 * fine for the few-thousand range a typical offline area produces.
 */
async function tileCacheStats() {
  try {
    const cache = await caches.open(TILES_CACHE);
    const requests = await cache.keys();
    let bytes = 0;
    // Best-effort byte count: many cross-origin tile responses don't
    // carry Content-Length, so we read the cached blob's size where
    // available and estimate ~12KB per tile when not. Cheap because
    // the cache is local; a few thousand tiny lookups complete fast.
    for (const req of requests) {
      const res = await cache.match(req);
      if (!res) continue;
      const len = res.headers.get('content-length');
      if (len) {
        const n = Number.parseInt(len, 10);
        bytes += Number.isFinite(n) ? n : 12_000;
      } else {
        const blob = await res.clone().blob().catch(() => null);
        bytes += blob?.size ?? 12_000;
      }
    }
    return { count: requests.length, bytes };
  } catch {
    return { count: 0, bytes: 0 };
  }
}

/**
 * Navigation handler for /field. Network-first so the live catalog
 * always wins when there's signal; on network failure we serve the
 * pre-cached static shell that hydrates from IndexedDB. The shell
 * lists every cached deployment with a tap target back into the
 * runtime, so the user can keep working offline.
 */
async function fieldNavigateWithFallback(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(FIELD_OFFLINE_SHELL);
    if (cached) return cached;
    // SW couldn't pre-cache the shell at install time. Last-resort
    // inline HTML so the user isn't dumped on the browser's
    // generic "no internet" screen.
    return new Response(
      '<!DOCTYPE html><meta charset="utf-8"><title>Offline</title>' +
        '<body style="font-family:system-ui;padding:2rem;color:#333;">' +
        '<h1>Offline</h1><p>The cached catalog page is missing. ' +
        'Reconnect and reload to refresh.</p></body>',
      { headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  }
}

async function networkFirstWithCache(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Network failed: serve from cache.
    const cached = await cache.match(request);
    if (cached) return cached;
    // No cache either; return an empty FeatureCollection so MapLibre
    // doesn't crash when the layer source URL resolves.
    return new Response(
      JSON.stringify({ type: 'FeatureCollection', features: [] }),
      { headers: { 'content-type': 'application/json' } },
    );
  }
}

