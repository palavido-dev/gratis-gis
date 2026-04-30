/**
 * Pre-fetches basemap tiles for an offline area so the field client
 * has them available when the radio drops. Slice 10 of the offline
 * arc (#208 sub-task — the tile-cache piece). Pairs with the tile
 * cache strategy in `public/sw.js`.
 *
 * The mechanism is intentionally simple: the warmer fires plain
 * `fetch()` requests for each tile URL the bbox covers at the
 * configured zoom range. The service worker intercepts those (via
 * the tile URL pattern in sw.js), caches the responses, and serves
 * them on subsequent requests. We never touch CacheStorage from
 * the main thread; the SW owns that surface.
 *
 * Trade-offs deliberately accepted in this v1:
 *
 *   - **No retry on individual tile failures.** A 504 / network
 *     error on one tile is reported in the progress callback but
 *     doesn't halt the run. Worst case the user gets an
 *     intermittently-blank tile offline; far better than failing
 *     the whole download because of one transient blip.
 *
 *   - **Bbox-only.** Polygon-shaped offline areas (when the admin-
 *     defined offline_area work lands in Slice 8/9) will need a
 *     more elaborate walker that skips tiles fully outside the
 *     polygon. v1 walks the rectangular envelope.
 *
 *   - **No deduplication across deployments.** Two deployments that
 *     overlap will each request the same tiles; the SW cache hashes
 *     by URL so the second deployment's requests are served from
 *     cache (no double network), but the warmer still iterates them.
 *     A future optimisation skips already-cached tiles up front.
 *
 *   - **Concurrency limited to a small pool.** Browsers cap parallel
 *     fetches to a handful per origin anyway; a 6-deep pool gets us
 *     close to the practical max without burning through provider
 *     rate limits. Tunable per call.
 */

/**
 * Standard slippy-map tile coordinate. Used internally and exported
 * for tests / future polygon-clipping work.
 */
export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

export interface TileWarmInput {
  /** Tile URL templates with {z}/{x}/{y} placeholders. Multiple
   *  templates supported because a single basemap can have raster +
   *  glyph tiles, or we may warm a basemap + a vector overlay
   *  source in one pass. */
  urlTemplates: string[];
  /** Geographic envelope in EPSG:4326: [west, south, east, north]. */
  bbox: [number, number, number, number];
  /** Inclusive zoom range. Defaults to [12, 17] which covers most
   *  field-survey use cases without exploding tile counts. */
  zoomRange?: [number, number];
  /** Soft cap on total tiles fetched. Protects against an admin
   *  configuring a huge bbox at zoom 19 and accidentally pulling
   *  100 000 tiles. Default 5 000 tiles ~= 1 GB. */
  maxTiles?: number;
  /** Parallel request count. Default 6. */
  concurrency?: number;
}

export interface TileWarmProgress {
  total: number;
  fetched: number;
  failed: number;
  /** Approximate bytes downloaded. Rough estimate when Content-
   *  Length is missing from the response headers. */
  bytes: number;
}

const DEFAULT_ZOOM: [number, number] = [12, 17];
const DEFAULT_MAX_TILES = 5_000;
const DEFAULT_CONCURRENCY = 6;
const ESTIMATED_BYTES_PER_TILE_MISSING_HEADER = 25_000;

/**
 * Warm the tile cache for a bbox. Reports progress per fetch via
 * the optional callback so the UI can render a counter; resolves
 * with the final tally.
 *
 * Cancellation: pass an AbortSignal to halt mid-walk (the user
 * navigated away, the download was cancelled, etc). In-flight
 * fetches cancel cleanly; the queue stops feeding new ones.
 */
export async function warmTiles(
  input: TileWarmInput,
  onProgress?: (p: TileWarmProgress) => void,
  signal?: AbortSignal,
): Promise<TileWarmProgress> {
  const zoomRange = input.zoomRange ?? DEFAULT_ZOOM;
  const maxTiles = input.maxTiles ?? DEFAULT_MAX_TILES;
  const concurrency = input.concurrency ?? DEFAULT_CONCURRENCY;
  const tiles = enumerateTiles(input.bbox, zoomRange, maxTiles);
  const total = tiles.length * input.urlTemplates.length;
  const progress: TileWarmProgress = { total, fetched: 0, failed: 0, bytes: 0 };
  if (total === 0) {
    onProgress?.(progress);
    return progress;
  }

  // Build the full URL list up front so the workers can pop from a
  // shared queue. URLs not tiles (no z/x/y placeholders) are
  // skipped silently -- a misconfigured basemap shouldn't take down
  // the warm pass.
  const urls: string[] = [];
  for (const tpl of input.urlTemplates) {
    for (const tile of tiles) {
      const url = expand(tpl, tile);
      if (url) urls.push(url);
    }
  }

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < urls.length) {
      if (signal?.aborted) return;
      const i = cursor++;
      const url = urls[i];
      if (!url) return;
      try {
        const res = await fetch(url, { signal: signal ?? null });
        if (res.ok || res.type === 'opaque') {
          progress.fetched += 1;
          const len = res.headers.get('content-length');
          if (len) {
            const n = Number.parseInt(len, 10);
            progress.bytes += Number.isFinite(n)
              ? n
              : ESTIMATED_BYTES_PER_TILE_MISSING_HEADER;
          } else {
            progress.bytes += ESTIMATED_BYTES_PER_TILE_MISSING_HEADER;
          }
        } else {
          progress.failed += 1;
        }
      } catch {
        progress.failed += 1;
      }
      onProgress?.(progress);
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, () => worker()),
  );
  return progress;
}

/**
 * Compute the slippy-map tile range that covers a bbox at one zoom
 * level, then iterate all zooms in the range. Result is sorted from
 * lowest zoom to highest so a partial run still yields the tiles
 * the user is most likely to see first (overview tiles before
 * detail tiles).
 *
 * Stops early if the result would exceed `maxTiles` so an
 * accidentally-huge area at zoom 19 is bounded rather than fatal.
 *
 * Exposed for tests and for future polygon-clipping refinement.
 */
export function enumerateTiles(
  bbox: [number, number, number, number],
  zoomRange: [number, number],
  maxTiles: number,
): TileCoord[] {
  const [w, s, e, n] = bbox;
  const [zMin, zMax] = zoomRange;
  const out: TileCoord[] = [];
  for (let z = zMin; z <= zMax; z += 1) {
    const xMin = lonToTileX(w, z);
    const xMax = lonToTileX(e, z);
    // Note: y is inverted in slippy-map convention (y=0 is north).
    const yMin = latToTileY(n, z);
    const yMax = latToTileY(s, z);
    for (let x = xMin; x <= xMax; x += 1) {
      for (let y = yMin; y <= yMax; y += 1) {
        if (out.length >= maxTiles) return out;
        out.push({ z, x, y });
      }
    }
  }
  return out;
}

function lonToTileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
}

function latToTileY(lat: number, z: number): number {
  const radians = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) /
      2) *
      Math.pow(2, z),
  );
}

/**
 * Expand a tile URL template by substituting {z}, {x}, {y}. Returns
 * null when the template has no slippy-map placeholders -- those
 * are vector style URLs / WMS endpoints that the warmer can't
 * iterate, only the SW's passive cache can populate.
 *
 * Supports both `{z}/{x}/{y}` and the `{-y}` (TMS-flipped) variant
 * some providers use.
 */
function expand(tpl: string, t: TileCoord): string | null {
  if (!tpl.includes('{z}') || !tpl.includes('{x}')) return null;
  const flipped = (1 << t.z) - 1 - t.y;
  return tpl
    .replace('{z}', String(t.z))
    .replace('{x}', String(t.x))
    .replace('{y}', String(t.y))
    .replace('{-y}', String(flipped));
}

/**
 * Read aggregate tile cache stats from the service worker. Returns
 * null when no SW is registered (dev mode, browsers without SW
 * support). The SW responds via a MessageChannel port so the
 * caller can `await` the reply directly.
 */
export async function readTileCacheStats(): Promise<{
  count: number;
  bytes: number;
} | null> {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return null;
  const reg = await navigator.serviceWorker.ready.catch(() => null);
  if (!reg?.active) return null;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => {
      resolve(
        typeof e.data === 'object' && e.data !== null
          ? (e.data as { count: number; bytes: number })
          : null,
      );
    };
    reg.active!.postMessage({ type: 'tile-cache-stats' }, [channel.port2]);
    // Timeout safeguard so a stuck SW doesn't hang the caller.
    setTimeout(() => resolve(null), 3_000);
  });
}

/**
 * Drop every cached tile. Used by the storage panel's "Free up
 * space" action. The SW does the actual delete so the call is just
 * a postMessage round-trip.
 */
export async function clearTileCache(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return false;
  const reg = await navigator.serviceWorker.ready.catch(() => null);
  if (!reg?.active) return false;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => {
      const ok =
        typeof e.data === 'object' && e.data !== null && 'ok' in e.data
          ? Boolean((e.data as { ok: unknown }).ok)
          : false;
      resolve(ok);
    };
    reg.active!.postMessage({ type: 'tile-cache-clear' }, [channel.port2]);
    setTimeout(() => resolve(false), 3_000);
  });
}
