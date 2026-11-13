// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { DataLayerAttachmentsService } from '../data-layer/attachments.service.js';
import { ItemsService } from '../items/items.service.js';
import { PointCloudService } from '../point-cloud/point-cloud.service.js';
import { TileLayerService } from '../tile-layer/tile-layer.service.js';
import { StorageController } from './storage.controller.js';

/**
 * API-DATA-02: a storage key was pinned to its kind's prefix but not
 * to its owner. Item data and attachment URLs carry keys to every
 * reader, so a reader could copy a victim's key into their own item
 * and then have finalize, purge or attachment remove delete it, or
 * republish it through a public item.
 */

const ATTACKER = { id: 'attacker', orgId: 'o1', orgRole: 'contributor' } as unknown as AuthUser;
const VICTIM_COG = 'item-tile-layer/victim-cog';
const VICTIM_FILE = 'item-file/victim-file';
const VICTIM_ATTACHMENT = 'feature-attachment/victim-photo';
const VICTIM_CLOUD = 'item-point-cloud/victim-cloud';

/** A prisma stand-in: grants are a map of key to user id, and
 *  `referenced` decides isKeyReferencedElsewhere. */
function prismaWith(opts: { grants?: Record<string, string>; referenced?: boolean } = {}) {
  const grants = opts.grants ?? {};
  return {
    storageUploadGrant: {
      findMany: jest.fn(async (args: { where: { key: { in: string[] }; userId: string } }) =>
        args.where.key.in
          .filter((k) => grants[k] === args.where.userId)
          .map((key) => ({ key })),
      ),
      create: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    $queryRaw: jest.fn(async () => [{ found: opts.referenced ?? false }]),
  };
}

describe('tile-layer finalize (failure a)', () => {
  function service(prisma: ReturnType<typeof prismaWith>) {
    const storage = {
      streamObjectToDisk: jest.fn(),
      deleteObject: jest.fn(),
    };
    const items = {
      get: jest.fn(async () => ({
        id: 'attacker-tl',
        type: 'tile_layer',
        data: { kind: 'raster' },
      })),
      update: jest.fn(),
    };
    const svc = new TileLayerService(
      items as never,
      { canAdmin: () => true } as never,
      storage as never,
      prisma as never,
      new ConfigService(),
    );
    return { svc, storage };
  }

  it("refuses another item's key before streaming or deleting it", async () => {
    const t = service(prismaWith());
    await expect(
      t.svc.finalizeUpload(ATTACKER, 'attacker-tl', {
        storageKey: VICTIM_COG,
        storageUrl: 'x',
        fileName: 'x.tif',
        sizeBytes: 10,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(t.storage.streamObjectToDisk).not.toHaveBeenCalled();
    expect(t.storage.deleteObject).not.toHaveBeenCalled();
  });

  it('refuses mosaic sources the caller was not issued', async () => {
    const t = service(prismaWith());
    jest
      .spyOn(t.svc as unknown as { assertMosaicTarget: () => unknown }, 'assertMosaicTarget')
      .mockResolvedValue({ id: 'attacker-tl', type: 'tile_layer', data: {} } as never);
    await expect(
      t.svc.mosaicBuild(ATTACKER, 'attacker-tl', {
        sources: [{ storageKey: VICTIM_COG, fileName: 'a.tif', sizeBytes: 10 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('purge leaves an object another item still references', async () => {
    const storage = { deleteObject: jest.fn() };
    const svc = Object.create(ItemsService.prototype) as ItemsService;
    Object.assign(svc, { prisma: prismaWith({ referenced: true }), storage });
    await svc.tearDownItemBackingStorage('attacker-tl', 'tile_layer', {
      kind: 'raster',
      storageKey: VICTIM_COG,
    });
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it('purge deletes every key a tile layer names, not just storageKey', async () => {
    const storage = { deleteObject: jest.fn(async () => undefined) };
    const svc = Object.create(ItemsService.prototype) as ItemsService;
    Object.assign(svc, {
      prisma: prismaWith({ referenced: false }),
      storage,
      log: { warn: jest.fn() },
    });
    await svc.tearDownItemBackingStorage('tl', 'tile_layer', {
      storageKey: 'item-tile-layer/pyramid',
      cogStorageKey: 'item-tile-layer/source-cog',
      sources: [{ storageKey: 'item-tile-layer/src-1' }, { storageKey: 'item-file/elsewhere' }],
    });
    const deleted = storage.deleteObject.mock.calls.map((c) => (c as unknown as [string])[0]).sort();
    expect(deleted).toEqual([
      'item-tile-layer/pyramid',
      'item-tile-layer/source-cog',
      'item-tile-layer/src-1',
    ]);
  });
});

describe('asset picker File items', () => {
  it('purge deletes the public image key alongside storageKey', async () => {
    const storage = { deleteObject: jest.fn(async () => undefined) };
    const svc = Object.create(ItemsService.prototype) as ItemsService;
    Object.assign(svc, {
      prisma: prismaWith({ referenced: false }),
      storage,
      log: { warn: jest.fn() },
    });
    await svc.tearDownItemBackingStorage('f', 'file', {
      storageKey: '',
      publicImageKey: 'item-thumb/picked',
    });
    expect(storage.deleteObject).toHaveBeenCalledWith('item-thumb/picked');
  });

  it('purge will not delete a public image key outside item-thumb/', async () => {
    const storage = { deleteObject: jest.fn(async () => undefined) };
    const svc = Object.create(ItemsService.prototype) as ItemsService;
    Object.assign(svc, {
      prisma: prismaWith({ referenced: false }),
      storage,
      log: { warn: jest.fn() },
    });
    await svc.tearDownItemBackingStorage('f', 'file', {
      publicImageKey: 'feedback-screenshot/x',
    });
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });
});

describe('point-cloud finalize', () => {
  it("refuses another item's key", async () => {
    const storage = { deleteObject: jest.fn() };
    const svc = new PointCloudService(
      { get: async () => ({ id: 'pc', type: 'point_cloud', data: {} }) } as never,
      { canAdmin: () => true } as never,
      storage as never,
      prismaWith() as never,
      new ConfigService(),
    );
    await expect(
      svc.finalizeUpload(ATTACKER, 'pc', {
        storageKey: VICTIM_CLOUD,
        fileName: 'x.copc.laz',
        sizeBytes: 10,
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });
});

describe('generic item writes (failures b and d)', () => {
  function itemsService(existing: unknown, prisma: ReturnType<typeof prismaWith>) {
    const svc = Object.create(ItemsService.prototype) as ItemsService;
    const row = {
      id: 'attacker-file',
      orgId: 'o1',
      ownerId: 'attacker',
      type: 'file',
      title: 'Copy',
      tags: [],
      data: existing,
      updatedAt: new Date(),
    };
    const update = jest.fn(async (args: { data: Record<string, unknown> }) => ({
      ...row,
      ...args.data,
    }));
    const client: Record<string, unknown> = {
      ...prisma,
      itemShare: { findMany: async () => [] },
      item: { update },
      // update() writes under the item row lock (lockItemRow), which
      // reads the stored data and updated_at as epoch ms; the same
      // query stub still answers isKeyReferencedElsewhere.
      $queryRaw: jest.fn(async () => [
        {
          found: false,
          data: row.data,
          updated_at_ms: row.updatedAt.getTime(),
        },
      ]),
    };
    client.$transaction = async (fn: (tx: unknown) => unknown) => fn(client);
    Object.assign(svc, {
      get: async () => row,
      sharing: { canEdit: () => true },
      prisma: client,
    });
    return { svc, update };
  }

  it("a client PATCH cannot point an item at another item's file", async () => {
    const t = itemsService({ storageKey: '' }, prismaWith());
    await expect(
      t.svc.update(
        ATTACKER,
        'attacker-file',
        { data: { storageKey: VICTIM_FILE } } as never,
        { clientKeys: true },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(t.update).not.toHaveBeenCalled();
  });

  it('accepts a key issued to the caller, and an unchanged key', async () => {
    const mine = 'item-file/mine';
    const t = itemsService(
      { storageKey: 'item-file/legacy' },
      prismaWith({ grants: { [mine]: 'attacker' } }),
    );
    await t.svc.update(ATTACKER, 'attacker-file', { data: { storageKey: mine } } as never, {
      clientKeys: true,
    });
    await t.svc.update(
      ATTACKER,
      'attacker-file',
      { data: { storageKey: 'item-file/legacy', fileName: 'renamed.pdf' } } as never,
      { clientKeys: true },
    );
    expect(t.update).toHaveBeenCalledTimes(2);
  });

  it('a key issued to someone else is refused', async () => {
    const t = itemsService(
      { storageKey: '' },
      prismaWith({ grants: { [VICTIM_FILE]: 'victim' } }),
    );
    await expect(
      t.svc.update(ATTACKER, 'attacker-file', { data: { storageKey: VICTIM_FILE } } as never, {
        clientKeys: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('feature attachments (failure c)', () => {
  function service(prisma: Record<string, unknown>) {
    const storage = { headObjectSize: jest.fn(async () => 10), deleteObject: jest.fn() };
    const dataLayer = { listFeatures: jest.fn(async () => ({ features: [{}] })) };
    const svc = new DataLayerAttachmentsService(
      prisma as never,
      storage as never,
      dataLayer as never,
    );
    return { svc, storage };
  }

  it("register refuses another feature's attachment key", async () => {
    const prisma = { ...prismaWith(), featureAttachment: { create: jest.fn() } };
    const t = service(prisma);
    await expect(
      t.svc.register(
        'attacker-layer',
        'l1',
        'f1',
        { storageKey: VICTIM_ATTACHMENT, storageUrl: 'x', fileName: 'p.jpg', mime: 'image/jpeg' } as never,
        'attacker',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.featureAttachment.create).not.toHaveBeenCalled();
  });

  it('register stores a URL derived from the key, not the one the client sent', async () => {
    const own = 'feature-attachment/attacker-photo';
    const prisma = {
      ...prismaWith({ grants: { [own]: 'attacker' } }),
      featureAttachment: {
        create: jest.fn(async (args: unknown) => ({
          ...(args as { data: object }).data,
          id: 'a1',
          createdAt: new Date(0),
        })),
      },
    };
    const t = service(prisma);
    await t.svc.register(
      'attacker-layer',
      'l1',
      'f1',
      {
        storageKey: own,
        storageUrl: 'https://attacker.example/p.png',
        fileName: 'p.png',
        mime: 'image/png',
      } as never,
      'attacker',
    );
    const data = (prisma.featureAttachment.create.mock.calls[0]![0] as {
      data: { storageUrl: string };
    }).data;
    expect(data.storageUrl).toBe(
      '/api/portal/storage/private/feature-attachment/attacker-photo',
    );
  });

  it('remove leaves an object another row still references', async () => {
    const prisma = {
      ...prismaWith({ referenced: true }),
      featureAttachment: {
        findFirst: jest.fn(async () => ({ id: 'a1', storageKey: VICTIM_ATTACHMENT })),
        delete: jest.fn(async () => ({})),
      },
    };
    const t = service(prisma);
    await t.svc.remove('attacker-layer', 'l1', 'f1', 'a1');
    expect(prisma.featureAttachment.delete).toHaveBeenCalled();
    expect(t.storage.deleteObject).not.toHaveBeenCalled();
  });
});

describe('presign records who was issued the key', () => {
  it('writes a grant for the caller', async () => {
    const prisma = prismaWith();
    const storage = {
      presignUpload: jest.fn(async () => ({ key: 'item-file/new', uploadUrl: 'u' })),
    };
    const ctl = new StorageController(
      storage as never,
      prisma as never,
      {} as never,
      {} as never,
      {} as never, // engine, only used for attachment downloads
    );
    await ctl.presignUpload(ATTACKER, {
      kind: 'item-file',
      contentType: 'application/pdf',
      sizeBytes: 5,
    });
    expect(prisma.storageUploadGrant.create).toHaveBeenCalledWith({
      data: { key: 'item-file/new', userId: 'attacker' },
    });
  });
});
