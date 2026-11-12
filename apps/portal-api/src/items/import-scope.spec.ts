// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForbiddenException } from '@nestjs/common';

import { ItemsService } from './items.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { SharingService } from './sharing.service.js';
import { ImportJobsController } from '../import-jobs/import-jobs.controller.js';
import { IngestController } from '../ingest/ingest.controller.js';
import { pinDiskUpload } from '../ingest/ingest-disk-path.js';
import { resetIngestSlotsForTests } from '../ingest/ingest-slots.js';

/**
 * A bulk import can replace every row of a layer and insert anywhere.
 * An editor whose share is limited to their own rows or to an area
 * cannot authorize that, so every import route refuses them: the v3
 * sync import, the async import job and the v2 file ingest.
 */

const ITEM = '00000000-0000-4000-8000-0000000000d1';
const POLY = {
  type: 'Polygon',
  coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
};

const editor = {
  id: 'editor',
  orgId: 'org-1',
  orgRole: 'contributor',
  groupIds: [],
  capabilities: new Set(),
};

function editShare(extra: Record<string, unknown> = {}) {
  return {
    itemId: ITEM,
    principalType: 'user',
    principalId: 'editor',
    permission: 'edit',
    rowScope: 'all',
    editRowScope: null,
    expiresAt: null,
    geoLimit: null,
    geoBoundaryId: null,
    ...extra,
  };
}

function dataLayer(shares: unknown[], data: unknown) {
  return {
    id: ITEM,
    type: 'data_layer',
    orgId: 'org-1',
    ownerId: 'owner',
    access: 'private',
    deletedAt: null,
    orgGeoBoundaryId: null,
    publicGeoBoundaryId: null,
    data,
    shares,
  };
}

const V3 = {
  version: 3,
  storageType: 'postgis',
  layers: [{ id: 'L1', geometryType: 'point', fields: [] }],
};

function itemsService(shares: unknown[], data: unknown = V3) {
  const svc = Object.create(ItemsService.prototype) as ItemsService;
  Object.assign(svc, {
    prisma: { itemShare: { findMany: async () => shares } },
    sharing: new SharingService(undefined as never, new PolicyService()),
  });
  (svc as unknown as { get: unknown }).get = async () => dataLayer(shares, data);
  return svc;
}

describe('ItemsService.assertCanImportAllRows', () => {
  it('refuses a geo-limited editor', async () => {
    const svc = itemsService([editShare({ geoLimit: POLY })]);
    await expect(
      svc.assertCanImportAllRows(editor as never, ITEM),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses an editor limited to their own rows', async () => {
    const svc = itemsService([editShare({ editRowScope: 'own' })]);
    await expect(
      svc.assertCanImportAllRows(editor as never, ITEM),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses an editor on a layer whose policy is own-rows-only', async () => {
    const svc = itemsService([editShare()]);
    await expect(
      svc.assertCanImportAllRows(editor as never, ITEM, 'own-rows-only'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets an unlimited editor import', async () => {
    const svc = itemsService([editShare()]);
    await expect(
      svc.assertCanImportAllRows(editor as never, ITEM),
    ).resolves.toBeUndefined();
  });
});

describe('import routes refuse a limited editor', () => {
  afterEach(() => resetIngestSlotsForTests());

  it('the async import job is not enqueued', async () => {
    const staging = { getStaging: jest.fn() };
    const jobs = { enqueue: jest.fn() };
    const controller = new ImportJobsController(
      jobs as never,
      itemsService([editShare({ geoLimit: POLY })]),
      staging as never,
    );
    await expect(
      controller.createJob(editor as never, ITEM, 'L1', {
        stagingId: '0123abcd-0000-4000-8000-00000000cafe',
        sourceLayerName: 'x',
        mode: 'replace',
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(staging.getStaging).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('the v2 file ingest does not read the file', async () => {
    const shares = [editShare({ rowScope: 'own', editRowScope: 'own' })];
    const v2 = { version: 2, storageType: 'postgis' };
    const ingest = { fileToGeoJsonFromPath: jest.fn() };
    const features = { replaceAll: jest.fn(), provisionTable: jest.fn() };
    const controller = new IngestController(
      ingest as never,
      { get: async () => dataLayer(shares, v2) } as never,
      new SharingService(undefined as never, new PolicyService()),
      { itemShare: { findMany: async () => shares } } as never,
      features as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    const req = { id: 'import-scope-spec' };
    const dir = mkdtempSync(join(tmpdir(), 'gg-ingest-'));
    const path = join(dir, 'payload.geojson');
    writeFileSync(path, '{"type":"FeatureCollection","features":[]}');
    pinDiskUpload(req, dir, path);
    const file = {
      fieldname: 'file',
      originalname: 'upload.geojson',
      size: 40,
      destination: dir,
      path,
    } as unknown as Express.Multer.File;
    await expect(
      controller.ingestFile(editor as never, ITEM, file, req),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(ingest.fileToGeoJsonFromPath).not.toHaveBeenCalled();
    expect(features.replaceAll).not.toHaveBeenCalled();
  });
});
