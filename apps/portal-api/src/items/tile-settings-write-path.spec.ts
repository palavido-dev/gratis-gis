// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { ROLE_BASELINES, type CapabilityKey } from '../auth/capabilities.js';
import { ItemsService } from './items.service.js';

/**
 * Per-layer tile settings are validated where every data_layer write
 * passes: ItemsService.create and .update. Same bare-service harness
 * as attribution-write-path.spec.ts; the assertion is about what
 * reaches Prisma, or that nothing does.
 */

function contributor(): AuthUser {
  return {
    id: '00000000-0000-0000-0000-0000000000aa',
    orgId: '00000000-0000-0000-0000-0000000000bb',
    orgRole: 'contributor',
    capabilities: new Set<CapabilityKey>(ROLE_BASELINES.contributor),
  } as unknown as AuthUser;
}

function layerData(tiles: unknown) {
  return {
    version: 3,
    storageType: 'postgis',
    layers: [
      {
        id: 'parcels',
        label: 'Parcels',
        geometryType: 'polygon',
        fields: [{ name: 'name', type: 'string' }],
        tiles,
      },
    ],
  };
}

describe('ItemsService validates tile settings on write', () => {
  it('stores normalized settings on create', async () => {
    let stored: unknown;
    const svc = Object.create(ItemsService.prototype) as ItemsService;
    Object.assign(svc, {
      prisma: {
        item: {
          create: async (args: { data: { data?: unknown; type?: unknown } }) => {
            stored = args.data.data;
            return { id: 'i', type: args.data.type, data: args.data.data, updatedAt: new Date() };
          },
        },
      },
    });
    await svc.create(contributor(), {
      type: 'data_layer',
      title: 'L',
      data: layerData({ fields: ['name', 'removed'], cacheMaxAge: 120 }),
    } as never);
    const layer = (stored as ReturnType<typeof layerData>).layers[0]!;
    expect(layer.tiles).toEqual({ fields: ['name'], cacheMaxAge: 120 });
  });

  it('refuses an out-of-range setting on create', async () => {
    const create = jest.fn();
    const svc = Object.create(ItemsService.prototype) as ItemsService;
    Object.assign(svc, { prisma: { item: { create } } });
    await expect(
      svc.create(contributor(), {
        type: 'data_layer',
        title: 'L',
        data: layerData({ maxFeatures: 1_000_000 }),
      } as never),
    ).rejects.toThrow(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses an out-of-range setting on update before anything is written', async () => {
    const update = jest.fn();
    const transaction = jest.fn();
    const svc = Object.create(ItemsService.prototype) as ItemsService;
    Object.assign(svc, {
      get: async () => ({
        id: 'item-1',
        orgId: '00000000-0000-0000-0000-0000000000bb',
        type: 'data_layer',
        tags: [],
        data: layerData(undefined),
        updatedAt: new Date(),
      }),
      sharing: { canEdit: () => true },
      snapshots: { snapshot: async () => undefined },
      prisma: {
        itemShare: { findMany: async () => [] },
        item: { update },
        $transaction: transaction,
      },
    });
    await expect(
      svc.update(contributor(), 'item-1', {
        data: layerData({ cacheMaxAge: 86400 }),
      } as never),
    ).rejects.toThrow(/cacheMaxAge/);
    expect(update).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});
