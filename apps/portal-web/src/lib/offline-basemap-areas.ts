// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Which stored offline basemap archives a field deployment adopts.
 *
 * The field runtime used to adopt only areas named by a fresh
 * `GET /offline-areas`. Opened with no signal (the one case the
 * archive was downloaded for), or with an expired session, that read
 * fails, the list was empty, and the archive on the device sat
 * unused while the map tried the online basemap. Now the last good
 * area list is kept beside the archives, and without a server answer
 * every archive on the device is adopted. The "author deleted this
 * area" filter applies only when the server actually answered.
 *
 * No pmtiles import here, so this module loads under jest.
 */
import type { OfflineAreaWithPackage } from '@gratis-gis/shared-types';

/** Same cache offline-basemap.ts stores archives in. */
const CACHE = 'gratis-offline-basemap-v1';

function archivePrefix(itemId: string): string {
  return `/offline-basemap/${encodeURIComponent(itemId)}/`;
}

/** Outside the archive prefix, so listing archives never sees it. */
export function knownAreasKey(itemId: string): string {
  return `/offline-basemap-areas/${encodeURIComponent(itemId)}`;
}

/** Area ids that have an archive stored on this device. */
export async function listStoredBasemapAreaIds(itemId: string): Promise<string[]> {
  if (typeof caches === 'undefined') return [];
  try {
    const cache = await caches.open(CACHE);
    const prefix = archivePrefix(itemId);
    const out: string[] = [];
    for (const request of await cache.keys()) {
      const path = new URL(request.url).pathname;
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      out.push(decodeURIComponent(rest));
    }
    return out;
  } catch {
    return [];
  }
}

/** Keep the last area list the server gave, for opening offline. */
export async function saveKnownAreas(
  itemId: string,
  areas: OfflineAreaWithPackage[],
): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(CACHE);
    await cache.put(
      knownAreasKey(itemId),
      new Response(JSON.stringify(areas), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  } catch {
    // Quota or a private window. Adoption still works from the
    // archive keys; only the names in the status row are lost.
  }
}

export async function loadKnownAreas(
  itemId: string,
): Promise<OfflineAreaWithPackage[] | null> {
  if (typeof caches === 'undefined') return null;
  try {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(knownAreasKey(itemId));
    if (!hit) return null;
    const body = (await hit.json()) as unknown;
    return Array.isArray(body) ? (body as OfflineAreaWithPackage[]) : null;
  } catch {
    return null;
  }
}

export async function forgetKnownAreas(itemId: string): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(CACHE);
    await cache.delete(knownAreasKey(itemId));
  } catch {
    /* nothing to clean */
  }
}

/**
 * The areas to show and the archive ids to adopt.
 *
 * `server` is the fresh list when the read answered 200, else null.
 */
export function chooseOfflineAreas(input: {
  server: OfflineAreaWithPackage[] | null;
  saved: OfflineAreaWithPackage[] | null;
  storedIds: string[];
}): { areas: OfflineAreaWithPackage[]; adoptIds: string[] } {
  const stored = new Set(input.storedIds);
  if (input.server) {
    return {
      areas: input.server,
      adoptIds: input.server.map((a) => a.area.id).filter((id) => stored.has(id)),
    };
  }
  // No answer from the server: trust what is on the device. Show the
  // saved entries for archives that are here, so they can be seen
  // and removed offline.
  const saved = (input.saved ?? []).filter((a) => stored.has(a.area.id));
  return { areas: saved, adoptIds: [...input.storedIds] };
}
