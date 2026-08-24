// SPDX-License-Identifier: AGPL-3.0-or-later
import maplibregl from 'maplibre-gl';
import { FileSource, PMTiles, Protocol } from 'pmtiles';
import { layers, namedFlavor } from '@protomaps/basemaps';

/**
 * The offline basemap: one prepared archive, held on the device,
 * rendered without a network.
 *
 * The portal builds one vector archive per offline area (#70). This
 * module is the other end: download it once, keep it, and hand
 * MapLibre a style that reads tiles out of the local copy.
 *
 * Why a local archive rather than a cached tile URL. PMTiles is read
 * by byte range, and a cached Response cannot answer a range request
 * on its own; the Cache API has no notion of one. So the bytes go in
 * as a whole object and come back out as a File, which the pmtiles
 * library's FileSource slices directly. No service worker
 * involvement, no synthetic 206 responses, and it works identically
 * whether or not the device has a connection.
 *
 * Everything the style needs is same-origin: tiles from the local
 * archive, glyphs and sprites from `public/basemap`. That is what
 * makes it work with the radio off, and it is checked by the fact
 * that there is no absolute URL anywhere below.
 */

/**
 * Cache name for downloaded archives.
 *
 * Versioned separately from the service worker's caches because the
 * two are invalidated for different reasons: the SW bumps its version
 * when its caching rules change, and throwing away a collector's
 * 8 MB basemap because a fetch handler was edited would be a poor
 * trade. Nothing in sw.js opens this cache.
 */
export const OFFLINE_BASEMAP_CACHE = 'gratis-offline-basemap-v1';

/** Shown on the map, and required by the data's license. */
export const OFFLINE_BASEMAP_ATTRIBUTION =
  '© OpenStreetMap contributors, © Protomaps';

/**
 * Same-origin locations of the vendored glyph and sprite assets. See
 * public/basemap/README.md for what they are and why they are in the
 * repository rather than fetched.
 */
const GLYPHS = '/basemap/fonts/{fontstack}/{range}.pbf';
const SPRITE = '/basemap/sprite/light';

/** Source name inside the style. Arbitrary, but the layers agree. */
const SOURCE_NAME = 'protomaps';

/**
 * Cache key for one package. Uses a synthetic same-origin URL rather
 * than the API path so that a package stays retrievable after a
 * rebuild changes the package id, and so nothing confuses a cached
 * archive with a live API response.
 */
function cacheKeyFor(itemId: string, areaId: string): string {
  return `/offline-basemap/${encodeURIComponent(itemId)}/${encodeURIComponent(areaId)}`;
}

/**
 * The file name a stored archive is registered under. MapLibre
 * resolves `pmtiles://<name>/{z}/{x}/{y}` through the protocol's map
 * of added instances, which is keyed by the source's own key, and
 * FileSource's key is the file name. So this string is the join
 * between the style and the bytes.
 */
function archiveNameFor(itemId: string, areaId: string): string {
  return `offline-${itemId}-${areaId}.pmtiles`;
}

export interface BasemapDownloadProgress {
  receivedBytes: number;
  /** Null when the server did not declare a length. */
  totalBytes: number | null;
}

/**
 * Download a prepared package and keep it.
 *
 * Streams so the progress bar is honest on a slow connection rather
 * than sitting at zero and then jumping to done, which on a field
 * device reads as a hang and gets the download cancelled.
 */
export async function downloadOfflineBasemap(
  itemId: string,
  areaId: string,
  packageId: string,
  onProgress?: (p: BasemapDownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(
    `/api/portal/items/${itemId}/offline-packages/${packageId}/file`,
    signal ? { signal } : {},
  );
  if (!res.ok || !res.body) {
    throw new Error(`Could not download the map (${res.status}).`);
  }
  const declared = res.headers.get('content-length');
  const totalBytes = declared ? Number.parseInt(declared, 10) : null;

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      receivedBytes += value.byteLength;
      onProgress?.({
        receivedBytes,
        totalBytes: Number.isFinite(totalBytes) ? totalBytes : null,
      });
    }
  }

  const blob = new Blob(chunks as BlobPart[], {
    type: 'application/vnd.pmtiles',
  });
  const cache = await caches.open(OFFLINE_BASEMAP_CACHE);
  // Written last, in one put. A partial download never becomes a
  // cache entry, so "is it here?" and "is it complete?" are the same
  // question, and a cancelled download leaves nothing behind.
  await cache.put(
    cacheKeyFor(itemId, areaId),
    new Response(blob, {
      headers: {
        'content-type': 'application/vnd.pmtiles',
        'content-length': String(blob.size),
      },
    }),
  );
}

/** Size of the stored archive, or null when there is none. */
export async function storedBasemapSize(
  itemId: string,
  areaId: string,
): Promise<number | null> {
  if (typeof caches === 'undefined') return null;
  try {
    const cache = await caches.open(OFFLINE_BASEMAP_CACHE);
    const hit = await cache.match(cacheKeyFor(itemId, areaId));
    if (!hit) return null;
    const blob = await hit.blob();
    return blob.size;
  } catch {
    return null;
  }
}

/** Forget a stored archive. Returns whether one was there. */
export async function removeOfflineBasemap(
  itemId: string,
  areaId: string,
): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  try {
    const cache = await caches.open(OFFLINE_BASEMAP_CACHE);
    return await cache.delete(cacheKeyFor(itemId, areaId));
  } catch {
    return false;
  }
}

/**
 * Register a stored archive with the pmtiles protocol and return the
 * style that draws it, or null when nothing is stored.
 *
 * The protocol instance is re-created and re-registered on every
 * call rather than cached behind a flag. The registry is global
 * state on the maplibregl singleton that any other map surface can
 * overwrite, and #209 was a whole outage caused by a cached
 * "already registered" flag outliving the registration it described.
 */
export async function offlineBasemapStyle(
  itemId: string,
  areaId: string,
): Promise<maplibregl.StyleSpecification | null> {
  if (typeof caches === 'undefined') return null;
  const cache = await caches.open(OFFLINE_BASEMAP_CACHE);
  const hit = await cache.match(cacheKeyFor(itemId, areaId));
  if (!hit) return null;
  const blob = await hit.blob();

  const name = archiveNameFor(itemId, areaId);
  const file = new File([blob], name, { type: 'application/vnd.pmtiles' });
  const archive = new PMTiles(new FileSource(file));

  const protocol = new Protocol();
  protocol.add(archive);
  maplibregl.removeProtocol('pmtiles');
  maplibregl.addProtocol('pmtiles', protocol.tile);

  const header = await archive.getHeader();

  return {
    version: 8,
    glyphs: GLYPHS,
    sprite: SPRITE,
    sources: {
      [SOURCE_NAME]: {
        type: 'vector',
        // Resolved through the protocol's registry by file name, not
        // fetched. Nothing here touches the network.
        url: `pmtiles://${name}`,
        attribution: OFFLINE_BASEMAP_ATTRIBUTION,
      },
    },
    layers: layers(SOURCE_NAME, namedFlavor('light'), { lang: 'en' }),
    // Centre on what the archive actually holds, so a collector who
    // opens the deployment with no stored viewport lands on their
    // own area rather than in the ocean.
    center: [header.centerLon, header.centerLat],
    zoom: header.centerZoom,
  } as maplibregl.StyleSpecification;
}

/**
 * Whether this browser can hold an offline basemap at all.
 *
 * Cache Storage is unavailable on an insecure origin, which a
 * self-hosted portal reached over plain http on a LAN address is.
 * Worth checking before offering a download, because the failure
 * otherwise arrives after the bytes have already been transferred.
 */
export function canStoreOfflineBasemap(): boolean {
  return typeof caches !== 'undefined' && typeof window !== 'undefined';
}
