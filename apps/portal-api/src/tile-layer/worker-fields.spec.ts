// SPDX-License-Identifier: AGPL-3.0-or-later
import { keepTileWorkerFields } from '../items/items.service.js';
import { clampMaxZoom } from './pyramid.worker.js';

/**
 * A tile layer's processing state is the worker's. A client PATCH
 * could set it (and maxZoom) to values that stopped crash recovery for
 * every org or crashed the shared worker.
 */
describe('tile layer worker-owned fields', () => {
  it('keeps the stored worker fields over what a client sends', () => {
    const prev = { processingState: 'pmtiles-ready', maxZoom: 17, storageKey: 'a' };
    const next = {
      processingState: 'tiling',
      tilingStartedAt: 'x',
      maxZoom: 1e9,
      storageKey: 'a',
      attribution: 'new',
    };
    expect(keepTileWorkerFields(prev, next)).toEqual({
      processingState: 'pmtiles-ready',
      maxZoom: 17,
      storageKey: 'a',
      attribution: 'new',
    });
  });

  it('clamps the pyramid top zoom to an integer 0..24', () => {
    expect(clampMaxZoom(1e9)).toBe(24);
    expect(clampMaxZoom(-3)).toBe(0);
    expect(clampMaxZoom(12.7)).toBe(12);
    expect(clampMaxZoom('20')).toBe(18);
    expect(clampMaxZoom(undefined)).toBe(18);
  });
});
