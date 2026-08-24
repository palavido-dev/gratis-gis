// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * GratisGIS Service Worker
 *
 * Caching strategy:
 *   - Static assets (JS, CSS, fonts, images): Cache-first with background
 *     revalidation.
 *   - GeoJSON feature data (/api/portal/items/:id/geojson and the v3
 *     per-layer /api/portal/items/:id/layers/:key/geojson): Network-first
 *     with cache fallback so maps render offline with the last-seen dataset.
 *   - Tiles (raster XYZ, vector pbf/mvt, WMS GetMap, style.json):
 *     Cache-first in TILES_CACHE. Passively cached tiles (ordinary map
 *     browsing) are capped at RUNTIME_TILE_CAP entries with oldest-write
 *     eviction; tiles inside a downloaded deployment's bbox are pinned and
 *     never evicted (see "Tile cache cap" below).
 *   - Other portal-api reads (/api/portal/*): Network-first with no offline
 *     fallback (these need fresh auth tokens and change frequently).
 *   - Sign-out: the page posts 'gg:clear-user-caches' and the worker drops
 *     the tile + geojson caches (plus the tile write log), since both hold
 *     auth-gated org data.
 *
 * Offline WRITES, the honest version:
 *   - Field feature edits queue in the 'gratisgis-offline' IndexedDB
 *     (src/lib/offline-store.ts, store 'queue') and are drained in-app by
 *     src/lib/offline-sync.ts from the field runtime and catalog.
 *   - Form submissions queue in the 'gratisgis-forms' IndexedDB
 *     (src/lib/form-offline.ts, store 'submissions') and are drained in-app
 *     by the forms respond page.
 *   - Those in-app drains only run while a tab is open. This worker's
 *     Background Sync handler (the 'sync' event below) is the closed-tab
 *     safety net: pages arm the 'gg-offline-queue' tag on every enqueue and
 *     on load, and when connectivity returns the browser wakes this worker
 *     to replay BOTH queues, even with no tab open. Background Sync is
 *     Chromium-only; on Firefox/Safari the tag registration is silently
 *     skipped and the in-app drains remain the only replay path.
 *   - Both drains can run at once. That is safe by design: this worker
 *     claims rows via atomic IndexedDB status flips and the server is
 *     idempotent (feature inserts carry a client globalId into an
 *     append-only observation log; form submissions upsert on
 *     (formId, clientId)).
 *
 * Versioning: bump CACHE_VERSION on every deploy so stale assets are
 * evicted.
 */

// v6: runtime tile cache is now capped (RUNTIME_TILE_CAP) with
// oldest-write eviction and bbox pinning, and Background Sync replays
// the real offline queues. Rotating the cache names starts the tile
// write log and the tile caches in lockstep from empty, so eviction
// order is accurate from the first entry.
// (v5 widened the geojson cache pattern to the v3 per-layer shape and
// added the sign-out purge. v4 evicted static caches predating
// deploymentId-based asset URLs: Turbopack reuses chunk filenames
// across builds, so the ?dpl= query on asset URLs is what keeps each
// deploy's entries distinct.)
// (v7 stopped caching opaque tile responses. An opaque response hides
// its status, so a 429 from a rate-limiting basemap provider was
// cached as though it were a tile and then served forever by the
// cache-first path: a permanently blank basemap with no network
// requests and no error to see. The bump also evicts entries already
// poisoned that way on devices in the field.)
const CACHE_VERSION = 'v7';
const STATIC_CACHE = `gratis-static-${CACHE_VERSION}`;
const GEOJSON_CACHE = `gratis-geojson-${CACHE_VERSION}`;
// Slice 10: basemap + reference tiles. Keyed separately from static
// assets so the eviction policy can differ (tiles are large and we
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
 * We deliberately don't try to cache GeoJSON tiles here; the
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

// ---------------------------------------------------------------------------
// Lockstep constants: the offline write queues.
// ---------------------------------------------------------------------------
//
// !!! LOCKSTEP WARNING !!!
// A service worker cannot import TypeScript modules, so everything in
// this block is DUPLICATED BY HAND from the main-thread modules that
// own these databases:
//
//   src/lib/offline-store.ts   DB 'gratisgis-offline'
//     - store 'queue'        keyPath [dataCollectionId, id]; fields used
//       here: op, dataLayerId, layerKey, globalId, geometry, properties,
//       queuedAt, syncStatus ('pending'|'syncing'|'synced'|'failed'),
//       lastAttemptAt, retryCount, failureReason
//     - store 'deployments'  keyPath dataCollectionId; field used here:
//       bbox [west, south, east, north] (EPSG:4326)
//
//   src/lib/form-offline.ts    DB 'gratisgis-forms'
//     - store 'submissions'  keyPath clientId; fields used here:
//       clientId, formId, schemaVersion, response, capturedAt,
//       status ('queued'|'sending'|'sent'|'failed'), lastError, attempts
//     (form-offline.ts could not take a mirror comment in this change;
//     if you edit that file's schema, update this worker too.)
//
// Replay endpoints are likewise mirrored from src/lib/offline-sync.ts
// (feature queue) and the forms respond page (submissions). If you
// rename a store, change a keyPath, add a status value, or move an
// endpoint, update BOTH sides or background replay will silently stop
// matching the app's queues. There is no build-time injection for this
// file (it is served verbatim from /public), so hand-lockstep it is.
const OFFLINE_DB_NAME = 'gratisgis-offline';
const OFFLINE_QUEUE_STORE = 'queue';
const OFFLINE_DEPLOYMENTS_STORE = 'deployments';
const FORMS_DB_NAME = 'gratisgis-forms';
const FORMS_STORE = 'submissions';
// One-shot Background Sync tag. Lockstep with BACKGROUND_SYNC_TAG in
// src/lib/offline-store.ts (armed on enqueue, on form submit, and on
// SW registration).
const SYNC_TAG = 'gg-offline-queue';
// A row claimed ('syncing' / 'sending') this long ago is treated as
// abandoned (page killed mid-drain, worker terminated) and becomes
// claimable again. Two minutes comfortably exceeds one replay fetch.
const CLAIM_STALE_MS = 2 * 60 * 1000;

// ---------------------------------------------------------------------------
// Tile cache cap constants.
// ---------------------------------------------------------------------------

// Cap on PASSIVELY cached tiles (ordinary map browsing). Explicitly
// downloaded offline areas are budgeted separately: the tile warmer
// (src/lib/offline-tile-warmer.ts) allows up to 200k tiles per
// download, and those land in this same cache because the warmer just
// calls fetch() and this worker does the caching. We therefore cannot
// cap by total count; instead, tiles inside a cached deployment's
// bbox are PINNED (exempt from eviction) and only unpinned tiles
// count against this cap. 4000 tiles is roughly 100 MB at the
// warmer's ~25 KB/tile estimate: about a metro area of casual z12-z16
// panning, and only ~2% of the 200k explicit-download budget, so
// incidental browsing can no longer crowd out deliberate downloads
// under the origin's storage quota.
const RUNTIME_TILE_CAP = 4000;
// Tiles written less than this long ago are never evicted. This is
// the guard for the window DURING an offline-area download: the
// deployment manifest (and so its pinning bbox) is only written to
// IndexedDB AFTER tile warming finishes, so without a grace period a
// sweep could evict the first tiles of a large in-progress download.
// Six hours exceeds any plausible warm pass (200k tiles at even 10
// tiles/second is ~5.5 h) while still letting an abandoned partial
// download become reclaimable the same day.
const TILE_WRITE_GRACE_MS = 6 * 60 * 60 * 1000;
// Sweeps are O(cache size), so run at most one per minute per worker
// lifetime. Overshoot between sweeps is bounded by write rate and is
// harmless (tile puts already swallow quota errors).
const TILE_SWEEP_MIN_INTERVAL_MS = 60 * 1000;
// SW-owned metadata DB. Safe for this worker to create (unlike the
// app's DBs above, nothing else opens it with a competing schema).
// 'tileWrites' records {url, writtenAt} per cached tile because the
// Cache API keeps no timestamps.
const SW_META_DB = 'gratis-sw-meta';
const SW_META_VERSION = 1;
const TILE_WRITES_STORE = 'tileWrites';

let lastTileSweepAt = 0;

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
        // tries to read it anyway; worst case the user sees the
        // browser's offline screen.
      }),
    ),
  );
  // Skip waiting so the new SW activates immediately on the next navigate.
  self.skipWaiting();
});

// -------------------------------------------------------------------------
// Activate: clean up old caches, then reconcile the tile write log.
// -------------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  const keep = new Set([STATIC_CACHE, GEOJSON_CACHE, TILES_CACHE, SHELL_CACHE]);
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)),
      ),
    )
      .then(() => self.clients.claim())
      .then(() =>
        // Housekeeping after the version rotation: run one forced
        // sweep (covers deployments deleted while an old SW was in
        // charge) and drop tile write log rows whose cache entry no
        // longer exists (the log DB is not version-suffixed, so it
        // survives rotations that empty the tiles cache).
        sweepTileCache(true)
          .then(() => pruneTileWriteLog())
          .catch(() => {}),
      ),
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
  // permissive here on purpose; the URL pattern is restrictive
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
    // "Free up space" action. Clear the write log with the cache so
    // the two never disagree about what exists.
    void caches.delete(TILES_CACHE)
      .then(() => clearTileWriteLog())
      .then(() => {
        event.ports[0]?.postMessage({ ok: true });
      });
    return;
  }
  if (data.type === 'gg:clear-user-caches') {
    // Sign-out hook. The tile and geojson caches hold auth-gated
    // portal responses (MVT tiles, per-layer geojson) fetched with
    // the departing user's session; left in place, the next person
    // on a shared machine could read that org data straight out of
    // cache without ever signing in. The tile write log goes too:
    // its URLs can embed provider tokens and org endpoints. Static
    // assets and the offline shell carry no user data, so they
    // survive. The sender waits for the ack (with a timeout) before
    // navigating to Keycloak.
    void Promise.all([
      caches.delete(TILES_CACHE),
      caches.delete(GEOJSON_CACHE),
      clearTileWriteLog(),
    ]).then(() => {
      event.ports[0]?.postMessage({ ok: true });
    });
    return;
  }
});

// -------------------------------------------------------------------------
// Background Sync: replay the offline write queues after the tab closed.
//
// The in-app drains (src/lib/offline-sync.ts for feature edits, the
// forms respond page for submissions) are the primary path and give
// the user live feedback. This handler exists for the field worker
// who captures data offline, closes the tab, and walks back into
// coverage: the browser wakes this worker and the queues replay with
// no page open. Cookies flow on same-origin SW fetches, so the
// replays authenticate exactly like the in-app drains.
//
// Race tolerance (both drains can run at once):
//   1. Claim flags. Each row is claimed by flipping its status
//      ('syncing' / 'sending') inside a single readwrite IndexedDB
//      transaction, so two concurrent SW drains can never double-take
//      a row, and this worker skips rows the page recently claimed.
//      The in-app drains predate this handler and list their rows
//      non-atomically, so a small double-replay window remains.
//   2. Server idempotency closes that window. Feature inserts carry
//      the client-generated globalId into an append-only observation
//      log whose reads collapse to one feature per entity; updates
//      and deletes append observations and converge; DELETE 404 and
//      insert 409 are treated as already-done. Form submissions
//      upsert server-side on (formId, clientId), so a duplicate POST
//      is a no-op that returns success.
// -------------------------------------------------------------------------

self.addEventListener('sync', (event) => {
  if (event.tag !== SYNC_TAG) return;
  event.waitUntil(
    Promise.all([drainFeatureQueue(), drainFormsQueue()]).then(([a, b]) => {
      // Rejecting waitUntil tells the browser to re-fire this sync
      // later with its own backoff schedule. That is the retry timer
      // for rows that failed at the NETWORK level (still offline or
      // flapping at the edge of coverage). HTTP-level failures are
      // recorded on the row and do not reject: retrying a 4xx/5xx
      // without user action would burn the browser's limited retry
      // budget for nothing.
      if (a.retry || b.retry) {
        throw new Error('offline queue replay incomplete; browser will retry');
      }
    }),
  );
});

/**
 * Open one of the APP'S databases without ever creating it. Opening a
 * DB that does not exist yet would mint an empty version-1 database;
 * the page's own open(name, version) would then skip onupgradeneeded
 * and find no object stores, bricking the app's offline layer. So we
 * only open when indexedDB.databases() confirms existence. That API
 * ships everywhere Background Sync does (Chromium) plus modern
 * Firefox/Safari; where it is missing we behave as if the DB were
 * absent, which just means no background replay / no pinning there.
 * The versionless open also never up- or downgrades, so a future
 * SCHEMA_VERSION bump in offline-store.ts cannot make this worker
 * throw VersionError.
 */
async function openAppDbIfExists(name) {
  if (typeof indexedDB.databases !== 'function') return null;
  const dbs = await indexedDB.databases().catch(() => null);
  if (!dbs || !dbs.some((d) => d && d.name === name)) return null;
  return new Promise((resolve) => {
    const req = indexedDB.open(name);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

/** Promisify an IDBRequest. */
function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IDB request failed'));
  });
}

/** getAll from a store, or [] when the store is missing. */
function idbGetAll(db, storeName) {
  if (!db.objectStoreNames.contains(storeName)) return Promise.resolve([]);
  return idbRequest(
    db.transaction(storeName, 'readonly').objectStore(storeName).getAll(),
  );
}

/** put, resolved on transaction completion. */
function idbPut(db, storeName, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IDB put failed'));
    tx.onabort = () => reject(tx.error || new Error('IDB put aborted'));
  });
}

/** delete, resolved on transaction completion. */
function idbDelete(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IDB delete failed'));
    tx.onabort = () => reject(tx.error || new Error('IDB delete aborted'));
  });
}

/**
 * Atomically claim a queue row: re-read it and flip its status inside
 * ONE readwrite transaction. IndexedDB serialises readwrite
 * transactions on a store, so of two concurrent claimants exactly one
 * sees the row in a claimable state. Returns the claimed row, or null
 * when the row is gone or someone else claimed it first.
 */
function claimRow(db, storeName, key, canClaim, patch) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const get = store.get(key);
    let claimed = null;
    get.onsuccess = () => {
      const row = get.result;
      if (!row || !canClaim(row)) return; // lost the race; tx completes empty
      claimed = Object.assign({}, row, patch);
      store.put(claimed); // same transaction: read-modify-write is atomic
    };
    get.onerror = () => reject(get.error || new Error('claim get failed'));
    tx.oncomplete = () => resolve(claimed);
    tx.onerror = () => reject(tx.error || new Error('claim tx failed'));
    tx.onabort = () => resolve(null);
  });
}

/**
 * Replay one feature-queue record against the live API. Mirrors
 * src/lib/offline-sync.ts replayRecord (lockstep!): same endpoints,
 * same bodies, same 404-on-delete forgiveness. Returns 'done' on
 * success, {reason} on an HTTP rejection, and THROWS only when fetch
 * itself fails (i.e. we are still offline), which the caller turns
 * into "leave the row pending and let the browser re-fire the sync".
 */
async function replayFeatureRecord(r) {
  const layerPath =
    '/api/portal/items/' +
    r.dataLayerId +
    '/layers/' +
    encodeURIComponent(r.layerKey) +
    '/features';
  let res;
  if (r.op === 'insert') {
    res = await fetch(layerPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        features: [
          {
            globalId: r.globalId,
            geometry: r.geometry,
            properties: r.properties || {},
          },
        ],
      }),
    });
    // Today's API accepts a replayed insert outright (append-only
    // observation log keyed by our globalId; reads collapse to one
    // feature). If a future server rejects duplicates with 409, the
    // record is already persisted, so treat it as done rather than
    // wedging the queue.
    if (res.status === 409) return 'done';
  } else if (r.op === 'update') {
    res = await fetch(layerPath + '/' + r.globalId, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        Object.assign(
          { properties: r.properties || {} },
          r.geometry !== null && r.geometry !== undefined
            ? { geometry: r.geometry }
            : {},
        ),
      ),
    });
  } else if (r.op === 'delete') {
    res = await fetch(layerPath + '/' + r.globalId, { method: 'DELETE' });
    // 404 on delete is benign: the feature is already gone server-
    // side (perhaps a prior replay succeeded but its response was
    // lost). Same treatment as offline-sync.ts.
    if (res.status === 404) return 'done';
  } else {
    return { reason: 'Unknown queue op: ' + r.op };
  }
  if (res.ok) return 'done';
  const body = await res.text().catch(() => '');
  return {
    reason: r.op + ' failed (' + res.status + '): ' + (body || res.statusText),
  };
}

/**
 * Drain the feature-edit queue ('gratisgis-offline' / 'queue') with
 * the same bookkeeping the in-app drain (offline-sync.ts) uses:
 * success deletes the row, an HTTP failure keeps it as 'failed' with
 * failureReason and an incremented retryCount, and a network failure
 * leaves it 'pending' for the browser's sync retry. Also reclaims
 * rows stranded in 'syncing' by a page that died mid-drain (the
 * in-app drain never re-lists those, so before this handler they
 * were stuck forever).
 */
async function drainFeatureQueue() {
  const db = await openAppDbIfExists(OFFLINE_DB_NAME);
  if (!db) return { retry: false };
  try {
    const rows = await idbGetAll(db, OFFLINE_QUEUE_STORE).catch(() => []);
    const now = Date.now();
    const canClaim = (r) =>
      r.syncStatus === 'pending' ||
      r.syncStatus === 'failed' ||
      (r.syncStatus === 'syncing' &&
        (!r.lastAttemptAt ||
          !(now - Date.parse(r.lastAttemptAt) < CLAIM_STALE_MS)));
    // Replay in capture order, like the in-app drain.
    const todo = rows
      .filter(canClaim)
      .sort((a, b) => String(a.queuedAt).localeCompare(String(b.queuedAt)));
    let retry = false;
    for (const record of todo) {
      const key = [record.dataCollectionId, record.id];
      let claimed = null;
      try {
        claimed = await claimRow(db, OFFLINE_QUEUE_STORE, key, canClaim, {
          syncStatus: 'syncing',
          lastAttemptAt: new Date().toISOString(),
        });
      } catch {
        retry = true;
        continue;
      }
      if (!claimed) continue; // another drain took it
      try {
        const outcome = await replayFeatureRecord(record);
        if (outcome === 'done') {
          await idbDelete(db, OFFLINE_QUEUE_STORE, key);
        } else {
          await idbPut(
            db,
            OFFLINE_QUEUE_STORE,
            Object.assign({}, claimed, {
              syncStatus: 'failed',
              failureReason: outcome.reason,
              retryCount: (record.retryCount || 0) + 1,
            }),
          );
        }
      } catch {
        // fetch itself threw: still offline / flaky. Restore the
        // pre-claim status (keeping any failure bookkeeping) so the
        // in-app UI shows the truth, and ask for a browser retry.
        await idbPut(
          db,
          OFFLINE_QUEUE_STORE,
          Object.assign({}, claimed, {
            syncStatus: record.syncStatus === 'failed' ? 'failed' : 'pending',
          }),
        ).catch(() => {});
        retry = true;
      }
    }
    return { retry };
  } finally {
    db.close();
  }
}

/**
 * True when a form response still embeds an offline-captured
 * attachment (duck-typed exactly like form-attachment-upload.ts's
 * isPending: has a dataUrl string and no url string).
 */
function responseHasPendingAttachment(node) {
  if (node === null || typeof node !== 'object') return false;
  if (typeof node.dataUrl === 'string' && typeof node.url !== 'string') {
    return true;
  }
  if (Array.isArray(node)) return node.some(responseHasPendingAttachment);
  return Object.keys(node).some((k) => responseHasPendingAttachment(node[k]));
}

/**
 * Drain the form-submission queue ('gratisgis-forms' / 'submissions').
 * Bookkeeping mirrors form-offline.ts markSent/markFailed: success
 * marks the row 'sent' (kept until the page's clearSent), an HTTP
 * failure marks 'failed' with lastError and attempts+1, a network
 * failure restores 'queued' and requests a browser retry.
 *
 * Rows whose response still contains pending offline attachments are
 * SKIPPED: uploading those needs the page's presign + PUT walk
 * (src/lib/form-attachment-upload.ts), and replicating that pipeline
 * here would double the lockstep surface. Those rows wait for the
 * in-app drain on next open; text-only submissions (the common case)
 * replay in the background.
 */
async function drainFormsQueue() {
  const db = await openAppDbIfExists(FORMS_DB_NAME);
  if (!db) return { retry: false };
  try {
    const rows = await idbGetAll(db, FORMS_STORE).catch(() => []);
    const now = Date.now();
    const canClaim = (r) =>
      r.status === 'queued' ||
      r.status === 'failed' ||
      // 'sending' is only ever written by this worker (the page's
      // drain sends without a claim flag), so a stale one means we
      // died mid-send and should try again. swAttemptAt is our
      // private bookkeeping field; the page's QueuedSubmission type
      // neither knows nor needs it.
      (r.status === 'sending' &&
        (!r.swAttemptAt || !(now - Date.parse(r.swAttemptAt) < CLAIM_STALE_MS)));
    const todo = rows
      .filter(canClaim)
      .sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)));
    let retry = false;
    for (const row of todo) {
      if (responseHasPendingAttachment(row.response)) continue;
      let claimed = null;
      try {
        claimed = await claimRow(db, FORMS_STORE, row.clientId, canClaim, {
          status: 'sending',
          swAttemptAt: new Date().toISOString(),
        });
      } catch {
        retry = true;
        continue;
      }
      if (!claimed) continue;
      try {
        const res = await fetch(
          '/api/portal/forms/' + row.formId + '/submissions',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              clientId: row.clientId,
              schemaVersion: row.schemaVersion,
              response: row.response,
              capturedAt: row.capturedAt,
            }),
          },
        );
        // The server upserts on (formId, clientId), so a duplicate
        // send (the page drain raced us) comes back 2xx. 409 is kept
        // as a defensive alias for "already accepted".
        if (res.ok || res.status === 409) {
          await idbPut(
            db,
            FORMS_STORE,
            Object.assign({}, claimed, { status: 'sent' }),
          );
        } else {
          const body = await res.text().catch(() => '');
          await idbPut(
            db,
            FORMS_STORE,
            Object.assign({}, claimed, {
              status: 'failed',
              lastError: res.status + ' ' + (body || res.statusText),
              attempts: (row.attempts || 0) + 1,
            }),
          );
        }
      } catch {
        await idbPut(
          db,
          FORMS_STORE,
          Object.assign({}, claimed, {
            status: row.status === 'failed' ? 'failed' : 'queued',
          }),
        ).catch(() => {});
        retry = true;
      }
    }
    return { retry };
  } finally {
    db.close();
  }
}

// -------------------------------------------------------------------------
// Tile cache cap: approximate LRU for passively cached tiles.
//
// Every tile (passive browsing AND explicit offline-area downloads)
// lands in TILES_CACHE, because the tile warmer just calls fetch()
// and this worker caches whatever flows past. Eviction therefore
// must distinguish the two populations without any marker on the
// request:
//
//   - PINNED: a tile whose z/x/y footprint intersects the bbox of any
//     cached deployment (read from the app's 'deployments' store).
//     Warmed tiles are inside a deployment bbox by construction, so
//     pinning by geography keeps downloaded areas intact and releases
//     them automatically when the deployment is deleted. Passively
//     cached tiles inside a downloaded area are pinned too; that
//     false positive is fine, the user explicitly wants that area
//     offline.
//   - GRACE: tiles written in the last TILE_WRITE_GRACE_MS are never
//     evicted, covering the mid-download window before the manifest
//     (and so the pinning bbox) exists.
//   - Everything else is evictable, oldest write first, down to
//     RUNTIME_TILE_CAP entries.
//
// "Oldest write" is the approximation here: we log write times in a
// tiny IndexedDB store (the Cache API has no timestamps) but do NOT
// update the log on cache hits, because that would cost an IndexedDB
// write per tile READ on the map's hottest path. A tile viewed daily
// but written once can therefore be evicted despite being warm; it
// re-fetches online and re-enters the log as the newest entry, so
// repeated cycles approximate LRU. style.json entries are exempt:
// a handful of tiny records that vector basemaps cannot start
// offline without.
// -------------------------------------------------------------------------

let swMetaDbPromise = null;

/** Open (or create) the SW-owned metadata DB. Cached per SW lifetime. */
function openSwMetaDb() {
  if (swMetaDbPromise) return swMetaDbPromise;
  swMetaDbPromise = new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(SW_META_DB, SW_META_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TILE_WRITES_STORE)) {
        db.createObjectStore(TILE_WRITES_STORE, { keyPath: 'url' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return swMetaDbPromise;
}

/** Best-effort write-time log entry for a freshly cached tile. */
async function recordTileWrite(url) {
  const db = await openSwMetaDb();
  if (!db) return;
  try {
    db.transaction(TILE_WRITES_STORE, 'readwrite')
      .objectStore(TILE_WRITES_STORE)
      .put({ url, writtenAt: Date.now() });
  } catch {
    // Log is best-effort: a tile with no log row is treated as
    // oldest by the sweep, which at worst evicts it early and it
    // re-fetches online.
  }
}

/** url -> writtenAt map for the sweep. */
async function readTileWriteTimes() {
  const out = new Map();
  const db = await openSwMetaDb();
  if (!db) return out;
  try {
    const rows = await idbRequest(
      db
        .transaction(TILE_WRITES_STORE, 'readonly')
        .objectStore(TILE_WRITES_STORE)
        .getAll(),
    );
    for (const r of rows || []) {
      if (r && typeof r.url === 'string') out.set(r.url, r.writtenAt || 0);
    }
  } catch {
    // Fall through with whatever we collected.
  }
  return out;
}

/** Remove specific URLs from the write log (after eviction). */
async function deleteTileWriteEntries(urls) {
  if (urls.length === 0) return;
  const db = await openSwMetaDb();
  if (!db) return;
  await new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction(TILE_WRITES_STORE, 'readwrite');
    } catch {
      resolve();
      return;
    }
    const store = tx.objectStore(TILE_WRITES_STORE);
    for (const u of urls) store.delete(u);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

/** Drop the whole write log (tile cache cleared / sign-out). */
async function clearTileWriteLog() {
  const db = await openSwMetaDb();
  if (!db) return;
  await new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction(TILE_WRITES_STORE, 'readwrite');
    } catch {
      resolve();
      return;
    }
    tx.objectStore(TILE_WRITES_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

/**
 * Drop write-log rows whose cache entry no longer exists. Runs on
 * activate: the log DB is not version-suffixed, so a CACHE_VERSION
 * rotation (which empties the tiles cache) would otherwise leave the
 * log full of ghosts.
 */
async function pruneTileWriteLog() {
  const db = await openSwMetaDb();
  if (!db) return;
  const cache = await caches.open(TILES_CACHE);
  const keys = await cache.keys();
  const live = new Set(keys.map((r) => r.url));
  await new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction(TILE_WRITES_STORE, 'readwrite');
    } catch {
      resolve();
      return;
    }
    const cursorReq = tx.objectStore(TILE_WRITES_STORE).openCursor();
    cursorReq.onsuccess = () => {
      const c = cursorReq.result;
      if (!c) return; // transaction completes on its own
      if (!live.has(c.value.url)) c.delete();
      c.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

// Extraction twin of TILE_PATH_PATTERN, applied to a pathname (no
// query part, so the terminator is end-of-string).
const TILE_ZXY_EXTRACT =
  /\/(\d+)\/(\d+)\/(\d+)(?:[@.][^/?]*)?(?:\.(?:png|jpe?g|webp|pbf|mvt))?$/i;

/**
 * Parse z/x/y out of a tile URL. Returns null for non-slippy entries
 * (WMS GetMap, style.json) and for implausible matches (a date-like
 * /2024/01/15/ path segment fails the z <= 25 and x,y < 2^z checks).
 */
function parseTileZxy(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const m = TILE_ZXY_EXTRACT.exec(pathname);
  if (!m) return null;
  const z = Number(m[1]);
  const x = Number(m[2]);
  const y = Number(m[3]);
  if (!Number.isInteger(z) || z < 0 || z > 25) return null;
  const extent = Math.pow(2, z);
  if (!Number.isInteger(x) || x < 0 || x >= extent) return null;
  if (!Number.isInteger(y) || y < 0 || y >= extent) return null;
  return { z, x, y };
}

/** North-edge latitude of tile row y at zoom with 2^z rows. */
function tileRowLat(y, extent) {
  const t = Math.PI * (1 - (2 * y) / extent);
  return (Math.atan(Math.sinh(t)) * 180) / Math.PI;
}

/** Does tile (z, x, y in XYZ orientation) touch bbox [w, s, e, n]? */
function tileXyzTouchesBbox(z, x, y, bbox) {
  const extent = Math.pow(2, z);
  const west = (x / extent) * 360 - 180;
  const east = ((x + 1) / extent) * 360 - 180;
  const north = tileRowLat(y, extent);
  const south = tileRowLat(y + 1, extent);
  return west <= bbox[2] && east >= bbox[0] && south <= bbox[3] && north >= bbox[1];
}

/**
 * Bbox test used for pinning. Checks the y value under BOTH the XYZ
 * and the TMS-flipped interpretation: the warmer supports {-y}
 * templates and the URL alone cannot tell us which scheme a provider
 * uses. A false positive merely pins one extra tile; a false negative
 * would evict part of a downloaded area.
 */
function tileTouchesBbox(t, bbox) {
  if (tileXyzTouchesBbox(t.z, t.x, t.y, bbox)) return true;
  const flipped = Math.pow(2, t.z) - 1 - t.y;
  return tileXyzTouchesBbox(t.z, t.x, flipped, bbox);
}

/** Pinning bboxes: every cached deployment's envelope. */
async function readDeploymentBboxes() {
  const db = await openAppDbIfExists(OFFLINE_DB_NAME);
  if (!db) return [];
  try {
    const rows = await idbGetAll(db, OFFLINE_DEPLOYMENTS_STORE).catch(() => []);
    return rows
      .map((d) => d && d.bbox)
      .filter(
        (b) =>
          Array.isArray(b) &&
          b.length === 4 &&
          b.every((n) => typeof n === 'number' && Number.isFinite(n)),
      );
  } finally {
    db.close();
  }
}

/**
 * Evict unpinned tiles beyond RUNTIME_TILE_CAP, oldest write first.
 * Throttled because the scan is O(cache size); `force` (activate)
 * bypasses the throttle. Failures are swallowed: eviction is a
 * hygiene job and must never break tile serving.
 */
async function sweepTileCache(force) {
  const now = Date.now();
  if (!force && now - lastTileSweepAt < TILE_SWEEP_MIN_INTERVAL_MS) return;
  lastTileSweepAt = now;
  try {
    const cache = await caches.open(TILES_CACHE);
    const requests = await cache.keys();
    // Fast path: under the cap even before subtracting pinned tiles.
    if (requests.length <= RUNTIME_TILE_CAP) return;
    const bboxes = await readDeploymentBboxes();
    const writeTimes = await readTileWriteTimes();
    const evictable = [];
    for (const req of requests) {
      const url = req.url;
      let pathname = '';
      try {
        pathname = new URL(url).pathname;
      } catch {
        pathname = '';
      }
      // style.json entries are tiny, few, and required to boot a
      // vector basemap offline. Never evict them.
      if (STYLE_JSON_PATTERN.test(pathname)) continue;
      const t = parseTileZxy(url);
      if (t && bboxes.some((b) => tileTouchesBbox(t, b))) continue; // pinned
      evictable.push({ req, url, writtenAt: writeTimes.get(url) || 0 });
    }
    const overflow = evictable.length - RUNTIME_TILE_CAP;
    if (overflow <= 0) return;
    // Grace: never evict very recent writes (see TILE_WRITE_GRACE_MS).
    // Missing log rows read as writtenAt 0, i.e. oldest; a just-
    // written tile whose log entry has not committed yet could in
    // principle be swept, but sweeps are a minute apart and the tile
    // simply re-fetches online, so we accept that sliver.
    const candidates = evictable
      .filter((e) => now - e.writtenAt >= TILE_WRITE_GRACE_MS)
      .sort((a, b) => a.writtenAt - b.writtenAt)
      .slice(0, overflow);
    if (candidates.length === 0) return;
    await Promise.all(candidates.map((e) => cache.delete(e.req)));
    await deleteTileWriteEntries(candidates.map((e) => e.url));
  } catch {
    // Never let cache hygiene break the worker.
  }
}

// -------------------------------------------------------------------------
// Fetch strategy helpers
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
 * Cross-origin tiles used to get special care here: opaque responses
 * were cached on the reasoning that `response.ok` is false for
 * no-cors yet the body is still usable by MapLibre. Both halves are
 * true and the conclusion was still wrong, because an opaque response
 * reports status 0 whether it carries a tile or a 429, so "any
 * non-error response" could not actually tell the difference. See
 * the note in the body: we now cache only what we can verify.
 *
 * Every successful write also logs a write-time row and pokes the
 * (throttled) eviction sweep; see "Tile cache cap" above.
 */
async function tileCacheFirst(request) {
  const cache = await caches.open(TILES_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    // Cache only responses whose status we can actually read.
    //
    // This used to accept `response.type === 'opaque'` as well, right
    // under a comment saying "don't cache 4xx/5xx; a 404 tile
    // shouldn't poison the cache". Those two statements contradict
    // each other: an opaque response has status 0 and hides the real
    // one, so a 429 from a rate-limiting provider, or a 403 from one
    // that has blocked you, is indistinguishable from a tile and was
    // cached as if it were. Cache-first then serves that error for
    // the life of the cache. It presents as a permanently blank
    // basemap with no network requests and nothing in the console,
    // and it is most likely to happen straight after a large prefetch,
    // which is exactly what the old offline download did.
    //
    // The cost is that a provider serving tiles without CORS headers
    // is no longer cached, because we cannot tell success from
    // failure there. That is the right trade: unverifiable caching is
    // how the cache got poisoned. OSM and Carto both send
    // `Access-Control-Allow-Origin: *`, so the providers that matter
    // are unaffected, and the ones that are not are also the ones
    // whose terms we now refuse to prefetch anyway.
    if (response && response.ok) {
      // Clone before put: response body can only be consumed once.
      cache
        .put(request, response.clone())
        .then(() => {
          void recordTileWrite(request.url);
          void sweepTileCache(false);
        })
        .catch(() => {
          /* quota exhaustion or storage failure; ignore, the live
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
