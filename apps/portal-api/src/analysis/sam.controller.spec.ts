// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, HttpException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import {
  SAM_EMBED_MAX_IN_FLIGHT_PER_USER,
  SamController,
  supertileTouchesBbox,
} from './sam.controller.js';

/**
 * The SAM embedding route only needs read access to the imagery, and
 * every analysis kind shares one FIFO queue. A viewer must not be able
 * to flood it.
 */
const USER = { id: 'viewer-1', orgId: 'org-1', orgRole: 'viewer' } as unknown as AuthUser;
// Roughly Riverside County, CA.
const BBOX = [-117.7, 33.4, -114.4, 34.1];

/** The supertile at zoom z containing a lon/lat point. */
function cellAt(z: number, lon: number, lat: number) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return { z, gx: Math.floor(x / 4), gy: Math.floor(y / 4) };
}

function makeController(inFlight: number) {
  const create = jest.fn(async () => ({ id: 'job-new' }));
  const controller = new SamController(
    {
      analysisJob: {
        findFirst: async () => null,
        count: async () => inFlight,
        create,
      },
    } as never,
    {
      get: async () => ({
        type: 'tile_layer',
        bbox: BBOX,
        data: { kind: 'raster', cogStorageKey: 'item-tile-layer/x' },
      }),
    } as never,
    { objectExists: async () => false } as never,
    { get: () => 'server-heavy' } as never,
  );
  // The tier switch is configuration, not under test.
  (controller as unknown as { assertServerTier: () => void }).assertServerTier = () => undefined;
  return { controller, create };
}

describe('SAM embedding ensure', () => {
  it('queues a job for a cell over the imagery', async () => {
    const { controller, create } = makeController(0);
    const out = await controller.ensure(USER, 'img-1', cellAt(16, -116.5, 33.8));
    expect(out.state).toBe('working');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('refuses once the user already has the maximum in flight', async () => {
    const { controller, create } = makeController(SAM_EMBED_MAX_IN_FLIGHT_PER_USER);
    await expect(
      controller.ensure(USER, 'img-1', cellAt(16, -116.5, 33.8)),
    ).rejects.toBeInstanceOf(HttpException);
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a cell nowhere near the imagery', async () => {
    const { controller, create } = makeController(0);
    await expect(
      controller.ensure(USER, 'img-1', cellAt(16, 139.7, 35.7)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('supertileTouchesBbox', () => {
  it('does not refuse an item with no bbox', () => {
    expect(supertileTouchesBbox(16, 0, 0, [])).toBe(true);
  });
});

describe('SAM embedding download', () => {
  function controllerWith(streamObject: () => Promise<unknown>) {
    const c = new SamController(
      {} as never,
      {
        get: async () => ({
          type: 'tile_layer',
          bbox: BBOX,
          data: { kind: 'raster', cogStorageKey: 'item-tile-layer/x' },
        }),
      } as never,
      { streamObject } as never,
      { get: () => 'server-heavy' } as never,
    );
    return c;
  }
  const cell = cellAt(16, -116.5, 33.8);
  const res = { status: jest.fn(), setHeader: jest.fn() };

  it('answers 404 only for a missing embedding', async () => {
    const c = controllerWith(async () => {
      throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
    });
    await expect(
      c.fetch(USER, 'img-1', String(cell.z), String(cell.gx), String(cell.gy), res as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('lets a storage outage through instead of a "not ready" 404', async () => {
    const c = controllerWith(async () => {
      throw new Error('connect ECONNREFUSED minio:9000');
    });
    const err = await c
      .fetch(USER, 'img-1', String(cell.z), String(cell.gx), String(cell.gy), res as never)
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(HttpException);
  });
});
