/**
 * GratisGIS Service Worker
 *
 * Caching strategy:
 *   - Static assets (JS, CSS, fonts, images): Cache-first with background revalidation.
 *   - GeoJSON feature data (/api/portal/items/:id/geojson): Network-first with
 *     cache fallback so maps render offline with the last-seen dataset.
 *   - Other portal-api reads (/api/portal/*): Network-first with no offline fallback
 *     (these need fresh auth tokens and change frequently).
 *   - Queued writes: Stored in IndexedDB and replayed when online via Background Sync.
 *
 * Versioning: bump CACHE_VERSION on every deploy so stale assets are evicted.
 */

const CACHE_VERSION = 'v2';
const STATIC_CACHE = `gratis-static-${CACHE_VERSION}`;
const GEOJSON_CACHE = `gratis-geojson-${CACHE_VERSION}`;
// Slice 10: basemap + reference tiles. Keyed separately from static
// assets so the eviction policy can differ (tiles are large + we
// retain them aggressively for offline; static assets churn with
// every deploy and rotate via CACHE_VERSION).
const TILES_CACHE = `gratis-tiles-${CACHE_VERSION}`;
const SYNC_QUEUE_TAG = 'gratis-feature-sync';

// Detect the Next.js dev server. Dev chunks under /_next/static/ reuse
// filenames across restarts, so cache-first serves up stale JS whose
// module IDs no longer exist in the current webpack runtime — that
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

// Next.js static assets are served from /_next/static/ — these are
// content-addressed (hash in filename) so they are safe to cache forever.
const STATIC_PATTERNS = [
  /^\/_next\/static\//,
  /^\/fonts\//,
  /\.(?:png|jpg|jpeg|svg|ico|webp|woff2?)$/,
];

const GEOJSON_PATTERN = /\/api\/portal\/items\/[^/]+\/geojson/;

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
// Install: nothing special; let the browser manage static asset caching.
// -------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  // Skip waiting so the new SW activates immediately on the next navigate.
  self.skipWaiting();
});

// -------------------------------------------------------------------------
// Activate: clean up old caches.
// -------------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  const keep = new Set([STATIC_CACHE, GEOJSON_CACHE, TILES_CACHE]);
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
});

// -------------------------------------------------------------------------
// Background Sync: replay queued feature writes when back online.
// -------------------------------------------------------------------------
self.addEventListener('sync', (event) => {
  if (event.tag === SYNC_QUEUE_TAG) {
    event.waitUntil(replayQueue());
  }
});

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

async function networkFirstWithCache(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Network failed — serve from cache.
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

/**
 * Read pending writes from IndexedDB and replay them against the API.
 * Successfully replayed ops are removed from the queue. Failed ones
 * stay and will be retried on the next sync event.
 */
async function replayQueue() {
  let db;
  try {
    db = await openDb();
  } catch {
    return;
  }

  const tx = db.transaction('sync_queue', 'readwrite');
  const store = tx.objectStore('sync_queue');
  const ops = await idbAll(store);

  for (const op of ops) {
    try {
      await replayOp(op);
      // Remove on success.
      const delTx = db.transaction('sync_queue', 'readwrite');
      delTx.objectStore('sync_queue').delete(op.id);
      await idbComplete(delTx);
    } catch {
      // Leave in queue; will retry on next sync.
    }
  }
}

async function replayOp(op) {
  const { itemId, method, path, body } = op;
  const url = `/api/portal/items/${itemId}${path}`;
  const response = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`Sync failed: ${response.status}`);
  }
}

// -------------------------------------------------------------------------
// Minimal IndexedDB helpers (no library deps in SW scope)
// -------------------------------------------------------------------------

const DB_NAME = 'gratis-gis';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('sync_queue')) {
        const store = db.createObjectStore('sync_queue', { keyPath: 'id' });
        store.createIndex('itemId', 'itemId', { unique: false });
        store.createIndex('queuedAt', 'queuedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('feature_cache')) {
        const fc = db.createObjectStore('feature_cache', { keyPath: ['itemId', 'globalId'] });
        fc.createIndex('itemId', 'itemId', { unique: false });
        fc.createIndex('syncedAt', 'syncedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('sync_cursors')) {
        db.createObjectStore('sync_cursors', { keyPath: 'itemId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbAll(store) {
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbComplete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
