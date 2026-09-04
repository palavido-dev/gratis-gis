// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Taking a deployment off the device, completely.
 *
 * Offline state for one deployment is spread across two storage
 * systems: five IndexedDB stores, and a Cache Storage bucket holding
 * the prepared basemap archive. `deleteDeployment` only ever knew
 * about the first, so "Remove from device" left the basemap behind:
 * the single largest thing a download writes (10 MB for one county,
 * and a deployment can have several areas), reported as freed while
 * still occupying the origin's quota. A collector clearing space for
 * the next site got none of it back.
 *
 * The reason it went unnoticed for so long is that neither half is
 * wrong on its own; they were just never joined. One function, called
 * by both places that remove a deployment, is the fix. The store
 * cannot do this itself: it would drag the pmtiles library into every
 * module that touches IndexedDB, including the service worker
 * registrar.
 */

import { deleteDeployment } from './offline-store';
import { removeAllOfflineBasemaps } from './offline-basemap';

export interface RemovalResult {
  /** Prepared basemap archives deleted. */
  basemapsRemoved: number;
}

/**
 * Remove every trace of a deployment from this device.
 *
 * NOT safe to call without asking first: the cascade takes the write
 * queue with it, so any capture that has not reached the server is
 * destroyed. Both call sites confirm, and surface the unsynced count
 * before they do.
 */
export async function removeDeploymentFromDevice(
  dataCollectionId: string,
): Promise<RemovalResult> {
  // IndexedDB first. If the basemap purge fails (quota-less private
  // mode, a browser without Cache Storage) the deployment is still
  // gone, which is what the user asked for; the reverse order could
  // leave a basemap for a deployment that no longer exists and no
  // longer has a UI row to remove it from.
  await deleteDeployment(dataCollectionId);
  const basemapsRemoved = await removeAllOfflineBasemaps(dataCollectionId);
  return { basemapsRemoved };
}
