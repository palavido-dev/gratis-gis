// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { FeaturesController } from './features.controller.js';
import { IngestController } from '../ingest/ingest.controller.js';
import { pinDiskUpload } from '../ingest/ingest-disk-path.js';
import { resetIngestSlotsForTests } from '../ingest/ingest-slots.js';

/**
 * The v1/v2 feature routes and the v1/v2 ingest route rewrite
 * item.data in the v2 shape. On a v3 item that flipped `version` to 2
 * (or dropped `layers[]`) and broke every v3 route and field sync.
 * They now refuse v3 items before touching the table or the item.
 */

const ITEM = '40000000-0000-4000-8000-000000000001';
const user = { id: 'u', orgId: 'o', orgRole: 'admin', groupIds: [] } as unknown as AuthUser;

function v3Item() {
  return {
    id: ITEM,
    type: 'data_layer',
    ownerId: 'u',
    data: { version: 3, layers: [{ id: 'l', syncVersion: 4 }] },
    shares: [],
  };
}

function legacyController() {
  const features = {
    provisionTable: jest.fn(),
    tableExists: jest.fn(async () => true),
    replaceAll: jest.fn(),
    bulkInsert: jest.fn(),
    updateFeature: jest.fn(),
    deleteFeature: jest.fn(),
    query: jest.fn(async () => []),
  };
  const prisma = {
    itemShare: { findMany: jest.fn(async () => []) },
    item: { update: jest.fn() },
    $transaction: jest.fn(),
  };
  const controller = new FeaturesController(
    features as never,
    { get: jest.fn(async () => v3Item()) } as never,
    { canEdit: () => true } as never,
    prisma as never,
  );
  return { controller, features, prisma };
}

describe('legacy routes refuse v3 data layers', () => {
  it('POST /features/import does not provision a table or rewrite the item', async () => {
    const { controller, features, prisma } = legacyController();
    await expect(
      controller.bulkImport(user, ITEM, { type: 'FeatureCollection', features: [] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(features.provisionTable).not.toHaveBeenCalled();
    expect(features.replaceAll).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.item.update).not.toHaveBeenCalled();
  });

  it.each([
    ['list', (c: FeaturesController) => c.list(user, ITEM)],
    ['append', (c: FeaturesController) => c.append(user, ITEM, { features: [] })],
    ['update', (c: FeaturesController) => c.update(user, ITEM, ITEM, {})],
    ['remove', (c: FeaturesController) => c.remove(user, ITEM, ITEM)],
  ])('%s refuses a v3 item', async (_name, call) => {
    const { controller, features } = legacyController();
    await expect(call(controller)).rejects.toBeInstanceOf(BadRequestException);
    expect(features.bulkInsert).not.toHaveBeenCalled();
    expect(features.updateFeature).not.toHaveBeenCalled();
    expect(features.deleteFeature).not.toHaveBeenCalled();
  });

  describe('POST /items/:id/ingest', () => {
    afterEach(() => resetIngestSlotsForTests());

    it('refuses a v3 item before parsing or writing anything', async () => {
      const ingest = { fileToGeoJsonFromPath: jest.fn() };
      const features = { provisionTable: jest.fn(), replaceAll: jest.fn() };
      const prisma = {
        itemShare: { findMany: jest.fn(async () => []) },
        item: { update: jest.fn() },
      };
      const controller = new IngestController(
        ingest as never,
        { get: jest.fn(async () => v3Item()) } as never,
        { canEdit: () => true } as never,
        prisma as never,
        features as never,
        undefined as never,
        undefined as never,
        undefined as never,
      );
      const req = { id: 'v3-guard' };
      const dir = mkdtempSync(join(tmpdir(), 'gg-v3-guard-'));
      const path = join(dir, 'a.geojson');
      writeFileSync(path, '{"type":"FeatureCollection","features":[]}');
      pinDiskUpload(req, dir, path);
      const file = {
        originalname: 'a.geojson',
        size: 40,
        destination: dir,
        path,
      } as Express.Multer.File;
      await expect(
        controller.ingestFile(user, ITEM, file, req),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(ingest.fileToGeoJsonFromPath).not.toHaveBeenCalled();
      expect(features.replaceAll).not.toHaveBeenCalled();
      expect(prisma.item.update).not.toHaveBeenCalled();
    });
  });
});

describe('syncItemMeta', () => {
  it('reads item.data under the row lock and never downgrades a v3 item', async () => {
    const { controller, features } = legacyController();
    (features as unknown as { stats: jest.Mock }).stats = jest.fn(async () => ({
      featureCount: 1,
      bbox: null,
    }));
    const tx = {
      $queryRaw: jest.fn(async (..._args: unknown[]) => [
        { data: { version: 3, layers: [] } },
      ]),
      item: { update: jest.fn() },
    };
    const prisma = (controller as unknown as { prisma: { $transaction: jest.Mock } })
      .prisma;
    prisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    await (controller as unknown as { syncItemMeta: (id: string) => Promise<void> })
      .syncItemMeta(ITEM);
    const sql = (tx.$queryRaw.mock.calls[0]![0] as unknown as string[]).join('?');
    expect(sql).toContain('FOR UPDATE');
    expect(tx.item.update).not.toHaveBeenCalled();
  });

  it('merges the v2 metadata over the locked copy', async () => {
    const { controller, features } = legacyController();
    (features as unknown as { stats: jest.Mock }).stats = jest.fn(async () => ({
      featureCount: 7,
      bbox: [0, 0, 1, 1],
    }));
    const tx = {
      $queryRaw: jest.fn(async () => [{ data: { version: 2, fields: ['kept'] } }]),
      item: { update: jest.fn() },
    };
    const prisma = (controller as unknown as { prisma: { $transaction: jest.Mock } })
      .prisma;
    prisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    await (controller as unknown as { syncItemMeta: (id: string) => Promise<void> })
      .syncItemMeta(ITEM);
    expect(tx.item.update).toHaveBeenCalledWith({
      where: { id: ITEM },
      data: {
        data: expect.objectContaining({
          version: 2,
          fields: ['kept'],
          featureCount: 7,
          bbox: [0, 0, 1, 1],
        }),
      },
    });
  });
});
