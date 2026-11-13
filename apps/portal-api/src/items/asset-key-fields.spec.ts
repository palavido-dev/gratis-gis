// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { ItemsService } from './items.service.js';

/**
 * A tile_layer's cogStorageKey and pmtilesStorageKey name objects the
 * analysis worker downloads with its own credentials. The owner can
 * PATCH item data, so those keys are pinned to the item type's prefix
 * just like storageKey; otherwise an owner could point them at another
 * org's raster or a feedback screenshot and have the worker read it.
 */
const USER = { id: 'u1', orgId: 'o1', orgRole: 'contributor' } as unknown as AuthUser;

function serviceFor(
  existing: unknown,
  captured: { data?: unknown },
  type = 'tile_layer',
) {
  const svc = Object.create(ItemsService.prototype) as ItemsService;
  const row = {
    id: 'tl-1',
    orgId: 'o1',
    ownerId: 'u1',
    type,
    title: 'Imagery',
    tags: [],
    data: existing,
    updatedAt: new Date(),
  };
  Object.assign(svc, {
    get: async () => row,
    sharing: { canEdit: () => true },
    prisma: {
      itemShare: { findMany: async () => [] },
      item: {
        update: async (args: { data: { data?: unknown } }) => {
          captured.data = args.data.data;
          return { ...row, ...args.data };
        },
      },
    },
  });
  // update() writes under the item row lock; the locked read sees the
  // same row, so no concurrent change.
  const prisma = (svc as unknown as { prisma: Record<string, unknown> }).prisma;
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      ...prisma,
      $queryRaw: async () => [{ data: row.data, updated_at_ms: row.updatedAt.getTime() }],
    });
  return svc;
}

describe('tile_layer derived storage keys', () => {
  const base = { kind: 'raster', storageKey: 'item-tile-layer/a/src.tif' };

  it.each(['cogStorageKey', 'pmtilesStorageKey'])(
    'refuses a %s outside item-tile-layer/',
    async (field) => {
      await expect(
        serviceFor(base, {}).update(USER, 'tl-1', {
          data: { ...base, [field]: 'feedback-screenshot/someone-else.png' },
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('accepts a key under the item type prefix', async () => {
    const captured: { data?: unknown } = {};
    await serviceFor(base, captured).update(USER, 'tl-1', {
      data: { ...base, cogStorageKey: 'item-tile-layer/b/cog.tif' },
    } as never);
    expect(captured.data).toMatchObject({ cogStorageKey: 'item-tile-layer/b/cog.tif' });
  });

  it('keeps an existing item saveable when a stored key is carried over unchanged', async () => {
    const legacy = { ...base, pmtilesStorageKey: 'legacy-prefix/x.pmtiles' };
    const captured: { data?: unknown } = {};
    await serviceFor(legacy, captured).update(USER, 'tl-1', {
      data: { ...legacy, attribution: 'County' },
    } as never);
    expect(captured.data).toBeDefined();
  });
});

describe('file item publicImageKey', () => {
  const base = { version: 1, storageKey: '', storageUrl: 'https://x/item-thumb/a' };

  it('accepts a key under item-thumb/ on a file item', async () => {
    const captured: { data?: unknown } = {};
    await serviceFor(base, captured, 'file').update(USER, 'tl-1', {
      data: { ...base, publicImageKey: 'item-thumb/a' },
    } as never);
    expect(captured.data).toMatchObject({ publicImageKey: 'item-thumb/a' });
  });

  it('refuses a key outside item-thumb/', async () => {
    await expect(
      serviceFor(base, {}, 'file').update(USER, 'tl-1', {
        data: { ...base, publicImageKey: 'item-file/someone-else' },
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses the field on other item types', async () => {
    await expect(
      serviceFor({ kind: 'raster' }, {}).update(USER, 'tl-1', {
        data: { kind: 'raster', publicImageKey: 'item-thumb/a' },
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
