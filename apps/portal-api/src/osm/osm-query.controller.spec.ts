// SPDX-License-Identifier: AGPL-3.0-or-later
//
// /osm/query turned every internal error into a 400 carrying the raw
// message, and relational distances and negations had no cap.

import { BadRequestException } from '@nestjs/common';

import { OsmQueryController } from './osm-query.controller.js';
import { OsmSaveAsLayerService } from './save-as-layer.service.js';

const user = { id: 'u1', orgId: 'o1' } as never;
const BBOX = '0,0,0.1,0.1';

function controller(osm: Record<string, unknown>) {
  return new OsmQueryController(osm as never);
}

describe('GET /osm/query', () => {
  it('lets a server fault through as a 500, not a 400 with its text', async () => {
    const c = controller({
      resolve: jest.fn(async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
      }),
    });
    const err = await c.query(user, BBOX, 'cafe').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BadRequestException);
  });

  it('refuses a relational distance past the cap', async () => {
    const resolveRelational = jest.fn();
    const c = controller({ resolveRelational });
    await expect(
      c.query(
        user,
        BBOX,
        undefined,
        undefined,
        undefined,
        'relational',
        'school',
        JSON.stringify([{ presetId: 'park', distanceMeters: 5_000_000 }]),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(resolveRelational).not.toHaveBeenCalled();
  });

  it('refuses too many negations', async () => {
    const resolveRelational = jest.fn();
    const c = controller({ resolveRelational });
    const negs = Array.from({ length: 6 }, () => ({ presetId: 'park', distanceMeters: 100 }));
    await expect(
      c.query(
        user,
        BBOX,
        undefined,
        undefined,
        undefined,
        'relational',
        'school',
        JSON.stringify([{ presetId: 'park', distanceMeters: 100 }]),
        JSON.stringify(negs),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(resolveRelational).not.toHaveBeenCalled();
  });
});

describe('Save OSM overlay as a layer', () => {
  it('removes the new item when the feature insert fails', async () => {
    const items = {
      create: jest.fn(async () => ({ id: 'item-1' })),
      remove: jest.fn(async () => undefined),
      purge: jest.fn(async () => undefined),
    };
    const features = {
      insertFeatures: jest.fn(async () => {
        throw new Error('statement timeout');
      }),
    };
    const svc = new OsmSaveAsLayerService(items as never, features as never);
    await expect(
      svc.saveOverlayAsLayer({
        user,
        title: 'Cafes',
        features: [
          { type: 'Feature', id: 'node/1', geometry: { type: 'Point', coordinates: [1, 1] }, properties: { name: 'A' } },
        ] as never,
      }),
    ).rejects.toThrow(/statement timeout/);
    expect(items.remove).toHaveBeenCalledWith(user, 'item-1');
    expect(items.purge).toHaveBeenCalledWith(user, 'item-1');
  });
});
