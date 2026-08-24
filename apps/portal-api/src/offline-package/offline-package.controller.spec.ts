// SPDX-License-Identifier: AGPL-3.0-or-later
import { NotFoundException } from '@nestjs/common';
import { OfflinePackageController } from './offline-package.controller.js';
import type { OfflinePackageService } from './offline-package.service.js';
import type { ItemsService } from '../items/items.service.js';
import type { SharingService } from '../items/sharing.service.js';
import type { StorageService } from '../storage/storage.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

/**
 * Authorization and read-model pins (2026-08-24 review, finding 8).
 */

const USER = { id: 'u1', orgId: 'org1' } as unknown as AuthUser;

function makeController(over: {
  byId?: unknown;
  listForItem?: unknown[];
  itemData?: unknown;
  canRead?: boolean;
}) {
  const packages = {
    byId: jest.fn(async () => over.byId ?? null),
    listForItem: jest.fn(async () => over.listForItem ?? []),
    // Identity keeps the assertions about WHICH row was chosen
    // readable; the wire mapping itself is a trivial projection.
    toWire: (r: unknown) => r,
    enqueue: jest.fn(),
  } as unknown as OfflinePackageService;
  const items = {
    get: jest.fn(async () => ({
      id: 'item1',
      orgId: 'org1',
      data: over.itemData ?? { version: 1, mapId: 'm', offlineAreas: [] },
      shares: [],
    })),
  } as unknown as ItemsService;
  const sharing = {
    canRead: jest.fn(async () => over.canRead ?? true),
    canEdit: jest.fn(async () => true),
  } as unknown as SharingService;
  const storage = { streamObject: jest.fn() } as unknown as StorageService;
  return {
    controller: new OfflinePackageController(items, sharing, storage, packages),
    packages,
    storage,
  };
}

describe('OfflinePackageController.serve', () => {
  it('404s a package id that belongs to a different item', async () => {
    // This check is the only thing stopping a package id from being
    // a read primitive over every archive in the instance: without
    // it, any item the caller can read would authorize any package
    // anywhere. It must run BEFORE the sharing check, and it does:
    // the row mismatch throws before items.get is ever called.
    const { controller, storage } = makeController({
      byId: { id: 'pkg1', itemId: 'OTHER-item', storageKey: 'k', status: 'ready' },
    });
    await expect(
      controller.serve(
        USER,
        'item1',
        'pkg1',
        undefined,
        {} as never,
        {} as never,
      ),
    ).rejects.toThrow(NotFoundException);
    expect(
      (storage as unknown as { streamObject: jest.Mock }).streamObject,
    ).not.toHaveBeenCalled();
  });

  it('404s a package that has not been built', async () => {
    const { controller } = makeController({
      byId: { id: 'pkg1', itemId: 'item1', storageKey: null, status: 'queued' },
    });
    await expect(
      controller.serve(
        USER,
        'item1',
        'pkg1',
        undefined,
        {} as never,
        {} as never,
      ),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('OfflinePackageController.list lastFailure suppression', () => {
  const area = {
    id: 'a1',
    name: 'North',
    bbox: [-80, 38, -79, 39],
    minZoom: 0,
    maxZoom: 14,
  };
  const itemData = { version: 1, mapId: 'm', offlineAreas: [area] };

  function row(over: Record<string, unknown>) {
    return {
      areaId: 'a1',
      bbox: [-80, 38, -79, 39],
      minZoom: 0,
      maxZoom: 14,
      createdAt: new Date('2026-08-24T10:00:00Z'),
      finishedAt: null,
      ...over,
    };
  }

  it('surfaces a failure when it is the latest word', async () => {
    const { controller } = makeController({
      itemData,
      listForItem: [row({ id: 'f1', status: 'failed' })],
    });
    const out = await controller.list(USER, 'item1');
    expect(out.areas[0]?.lastFailure).toMatchObject({ id: 'f1' });
  });

  it('hides a failure while a rebuild is in flight', async () => {
    // The author already responded to the failure by rebuilding;
    // showing both reads as two problems instead of one recovery.
    const { controller } = makeController({
      itemData,
      listForItem: [
        row({ id: 'q1', status: 'queued' }),
        row({ id: 'f1', status: 'failed' }),
      ],
    });
    const out = await controller.list(USER, 'item1');
    expect(out.areas[0]?.lastFailure).toBeNull();
    expect(out.areas[0]?.pending).toMatchObject({ id: 'q1' });
  });

  it('hides a failure older than the current ready package', async () => {
    const { controller } = makeController({
      itemData,
      listForItem: [
        row({
          id: 'ready1',
          status: 'ready',
          createdAt: new Date('2026-08-24T12:00:00Z'),
          finishedAt: new Date('2026-08-24T12:05:00Z'),
        }),
        row({ id: 'f1', status: 'failed' }),
      ],
    });
    const out = await controller.list(USER, 'item1');
    expect(out.areas[0]?.lastFailure).toBeNull();
    expect(out.areas[0]?.current).toMatchObject({ id: 'ready1' });
  });

  it('surfaces a failure newer than the current ready package', async () => {
    // A working package exists, but the latest rebuild attempt
    // failed; the author needs to know the refresh is not landing.
    const { controller } = makeController({
      itemData,
      listForItem: [
        row({
          id: 'f-new',
          status: 'failed',
          createdAt: new Date('2026-08-24T14:00:00Z'),
        }),
        row({
          id: 'ready1',
          status: 'ready',
          createdAt: new Date('2026-08-24T12:00:00Z'),
          finishedAt: new Date('2026-08-24T12:05:00Z'),
        }),
      ],
    });
    const out = await controller.list(USER, 'item1');
    expect(out.areas[0]?.lastFailure).toMatchObject({ id: 'f-new' });
  });
});
