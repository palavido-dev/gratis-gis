// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Taking a deployment off the device, completely.
 *
 * Offline state for one deployment is spread across three storage
 * systems: six IndexedDB stores, a Cache Storage bucket holding the
 * prepared basemap archive, and the service worker's tile cache.
 * `deleteDeployment` only ever knew about the first, so "Remove from
 * device" left the basemap behind: the single largest thing a download
 * writes (10 MB for one county, and a deployment can have several
 * areas), reported as freed while still occupying the origin's quota.
 * A collector clearing space for the next site got none of it back.
 * The tile cache had the same problem from the other direction: the
 * runtime's Remove cleared it and the catalog's Remove did not, so the
 * same action freed a different amount depending on which screen it
 * was tapped from.
 *
 * The reason it went unnoticed for so long is that none of the halves
 * is wrong on its own; they were just never joined. One function,
 * called by both places that remove a deployment, is the fix. The
 * store cannot do this itself: it would drag the pmtiles library into
 * every module that touches IndexedDB, including the service worker
 * registrar.
 *
 * On the tile cache (#270): it is a shared, origin-wide cache, and the
 * original design left it alone on remove because another deployment
 * might still need those tiles. In practice that meant a worker who
 * removed a city-scale offline area and downloaded a smaller one kept
 * paying for the old area's tiles forever; the storage gauge never
 * went down even though the IndexedDB rows were gone. For a small org
 * with one or two active deployments at a time, clearing the whole
 * tile cache is the right trade: a small re-download on the next
 * download in exchange for honest storage accounting and actually
 * reclaiming the bytes the user just asked us to free.
 */

import { deleteDeployment } from './offline-store';
import { removeAllOfflineBasemaps } from './offline-basemap';
import { clearTileCache } from './offline-tile-warmer';

export interface RemovalResult {
  /** Prepared basemap archives deleted. */
  basemapsRemoved: number;
  /**
   * Whether the service worker confirmed the tile cache clear. False
   * when there is no worker (dev, unsupported browser), when it did
   * not answer in time, or when the call threw. Informational: the
   * deployment is gone either way.
   */
  tileCacheCleared: boolean;
}

/**
 * Remove every trace of a deployment from this device.
 *
 * NOT safe to call without asking first: the cascade takes the write
 * queue with it, so any capture that has not reached the server is
 * destroyed. Both call sites confirm, and surface the unsynced count
 * before they do.
 *
 * Order: IndexedDB, then the basemap archive, then the tile cache.
 * IndexedDB goes first because it is the thing the user asked for and
 * the thing every UI row is keyed on; if a later step fails the
 * deployment is still gone, whereas the reverse order could leave a
 * basemap for a deployment that no longer exists and no longer has a
 * row to remove it from. The tile cache goes last and is reached even
 * when the basemap purge throws (quota-less private mode, a browser
 * without Cache Storage): the two are independent stores, and a
 * failure in one is no reason to leave the other's bytes behind. The
 * basemap error still propagates once the tile clear has been
 * attempted, so the caller's log line stays truthful.
 */
export async function removeDeploymentFromDevice(
  dataCollectionId: string,
): Promise<RemovalResult> {
  await deleteDeployment(dataCollectionId);
  let basemapsRemoved = 0;
  let basemapError: unknown = null;
  try {
    basemapsRemoved = await removeAllOfflineBasemaps(dataCollectionId);
  } catch (err) {
    basemapError = err;
  }
  // Best-effort: clearTileCache already resolves false when there is
  // no worker or it does not answer, so a throw here is a genuine
  // messaging failure and still must not fail the remove.
  let tileCacheCleared = false;
  try {
    tileCacheCleared = await clearTileCache();
  } catch {
    tileCacheCleared = false;
  }
  if (basemapError !== null) throw basemapError;
  return { basemapsRemoved, tileCacheCleared };
}
