// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="jest" />
/**
 * "Remove from device" as one cascade over three stores.
 *
 * The collaborators are mocked because each already has its own
 * coverage or its own runtime (IndexedDB, Cache Storage, a service
 * worker channel); what this file pins is the joining: that all three
 * are called, in the documented order, and that a failure in the
 * basemap purge does not stop the tile cache from being cleared.
 */

jest.mock('./offline-store', () => ({
  deleteDeployment: jest.fn(),
}));
jest.mock('./offline-basemap', () => ({
  removeAllOfflineBasemaps: jest.fn(),
}));
jest.mock('./offline-tile-warmer', () => ({
  clearTileCache: jest.fn(),
}));

import { deleteDeployment } from './offline-store';
import { removeAllOfflineBasemaps } from './offline-basemap';
import { clearTileCache } from './offline-tile-warmer';
import { removeDeploymentFromDevice } from './offline-remove';

const deleteDeploymentMock = deleteDeployment as jest.MockedFunction<
  typeof deleteDeployment
>;
const removeBasemapsMock = removeAllOfflineBasemaps as jest.MockedFunction<
  typeof removeAllOfflineBasemaps
>;
const clearTileCacheMock = clearTileCache as jest.MockedFunction<
  typeof clearTileCache
>;

/** Records the order collaborators were entered, by name. */
function trackOrder(): string[] {
  const order: string[] = [];
  deleteDeploymentMock.mockImplementation(async () => {
    order.push('indexeddb');
  });
  removeBasemapsMock.mockImplementation(async () => {
    order.push('basemap');
    return 2;
  });
  clearTileCacheMock.mockImplementation(async () => {
    order.push('tiles');
    return true;
  });
  return order;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('removeDeploymentFromDevice', () => {
  it('clears IndexedDB, then the basemap archive, then the tile cache', async () => {
    const order = trackOrder();
    const result = await removeDeploymentFromDevice('dc-1');
    // IndexedDB first because it is what the user asked for and what
    // every UI row is keyed on; the tile cache last because it is the
    // shared, best-effort one.
    expect(order).toEqual(['indexeddb', 'basemap', 'tiles']);
    expect(deleteDeploymentMock).toHaveBeenCalledWith('dc-1');
    expect(removeBasemapsMock).toHaveBeenCalledWith('dc-1');
    expect(result).toEqual({ basemapsRemoved: 2, tileCacheCleared: true });
  });

  it('still clears the tile cache when the basemap purge rejects', async () => {
    const order = trackOrder();
    removeBasemapsMock.mockImplementation(async () => {
      order.push('basemap');
      throw new Error('no Cache Storage here');
    });
    // The error is still surfaced, so the caller's log line is honest,
    // but only after the tile clear has had its turn: the two stores
    // are independent and one failing is no reason to leave the
    // other's bytes on the device.
    await expect(removeDeploymentFromDevice('dc-1')).rejects.toThrow(
      'no Cache Storage here',
    );
    expect(order).toEqual(['indexeddb', 'basemap', 'tiles']);
    expect(clearTileCacheMock).toHaveBeenCalledTimes(1);
  });

  it('reports an unconfirmed tile clear without failing the remove', async () => {
    trackOrder();
    clearTileCacheMock.mockRejectedValue(new Error('worker went away'));
    const result = await removeDeploymentFromDevice('dc-1');
    expect(result.tileCacheCleared).toBe(false);
    expect(result.basemapsRemoved).toBe(2);
  });

  it('does not touch the other stores when IndexedDB refuses', async () => {
    trackOrder();
    deleteDeploymentMock.mockRejectedValue(new Error('blocked by another tab'));
    // Nothing downstream should run: with the rows still there the
    // deployment is still on the device, and clearing its basemap out
    // from under a row the user can still open would be the worse
    // outcome.
    await expect(removeDeploymentFromDevice('dc-1')).rejects.toThrow(
      'blocked by another tab',
    );
    expect(removeBasemapsMock).not.toHaveBeenCalled();
    expect(clearTileCacheMock).not.toHaveBeenCalled();
  });
});
