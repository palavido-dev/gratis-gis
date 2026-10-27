// SPDX-License-Identifier: AGPL-3.0-or-later
import { NotFoundException } from '@nestjs/common';

import { DataLayerFeaturesService } from './features.service.js';

describe('DataLayerFeaturesService.dismissSyncConflict', () => {
  function makeSvc(initialConflicts: Array<{ id: string }>) {
    let data = {
      version: 3 as const,
      layers: [
        {
          id: 'layer-1',
          syncConflicts: initialConflicts,
        },
      ],
    };
    let updatedAt = new Date('2026-10-27T12:00:00.000Z');
    const prisma = {
      item: {
        findUnique: jest.fn(async () => ({
          data,
          updatedAt,
          type: 'data_layer',
        })),
        updateMany: jest.fn(async ({ data: patch }: { data: { data: typeof data } }) => {
          data = patch.data;
          updatedAt = new Date();
          return { count: 1 };
        }),
      },
    };
    const svc = new DataLayerFeaturesService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { svc, prisma, getData: () => data };
  }

  it('removes only the matching conflict id', async () => {
    const { svc, getData } = makeSvc([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ]);
    await expect(
      svc.dismissSyncConflict({
        itemId: 'item-1',
        layerId: 'layer-1',
        conflictId: 'b',
      }),
    ).resolves.toEqual({ dismissed: true });
    expect(getData().layers[0]!.syncConflicts).toEqual([
      { id: 'a' },
      { id: 'c' },
    ]);
  });

  it('404s when the conflict id is missing', async () => {
    const { svc } = makeSvc([{ id: 'a' }]);
    await expect(
      svc.dismissSyncConflict({
        itemId: 'item-1',
        layerId: 'layer-1',
        conflictId: 'missing',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
