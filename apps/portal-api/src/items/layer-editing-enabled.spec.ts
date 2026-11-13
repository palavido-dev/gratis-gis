// SPDX-License-Identifier: AGPL-3.0-or-later
import { ForbiddenException } from '@nestjs/common';

import { ItemsService } from './items.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { SharingService } from './sharing.service.js';
import { ImportJobsController } from '../import-jobs/import-jobs.controller.js';

/**
 * A sublayer with editingEnabled off is frozen. Share holders (and the
 * Editor apps they run) are refused; the owner and org admins still
 * write, because some layer kinds are created with the flag off.
 */

const ITEM = '00000000-0000-4000-8000-0000000000e1';

const holder = {
  id: 'editor',
  orgId: 'org-1',
  orgRole: 'contributor',
  groupIds: [],
  capabilities: new Set(),
};
const owner = { ...holder, id: 'owner' };
const orgAdmin = { ...holder, id: 'boss', orgRole: 'admin' };

const share = {
  itemId: ITEM,
  principalType: 'user',
  principalId: 'editor',
  permission: 'edit',
  rowScope: 'all',
  editRowScope: null,
  expiresAt: null,
  geoLimit: null,
  geoBoundaryId: null,
};

function layerItem(editingEnabled: boolean | undefined) {
  return {
    id: ITEM,
    type: 'data_layer',
    orgId: 'org-1',
    ownerId: 'owner',
    access: 'private',
    deletedAt: null,
    orgGeoBoundaryId: null,
    publicGeoBoundaryId: null,
    data: {
      version: 3,
      storageType: 'postgis',
      layers: [{ id: 'L1', geometryType: 'point', fields: [], editingEnabled }],
    },
    shares: [share],
  };
}

function itemsService(editingEnabled: boolean | undefined) {
  const svc = Object.create(ItemsService.prototype) as ItemsService;
  Object.assign(svc, {
    prisma: { itemShare: { findMany: async () => [share] } },
    sharing: new SharingService(undefined as never, new PolicyService()),
  });
  (svc as unknown as { get: unknown }).get = async () =>
    layerItem(editingEnabled);
  return svc;
}

describe('ItemsService.assertLayerEditingEnabled', () => {
  const frozen = { editingEnabled: false };

  it('refuses a share holder on a frozen layer', () => {
    const svc = itemsService(false);
    expect(() =>
      svc.assertLayerEditingEnabled(holder as never, layerItem(false) as never, frozen),
    ).toThrow(ForbiddenException);
  });

  it('lets the owner and an org admin write to a frozen layer', () => {
    const svc = itemsService(false);
    for (const u of [owner, orgAdmin]) {
      expect(() =>
        svc.assertLayerEditingEnabled(u as never, layerItem(false) as never, frozen),
      ).not.toThrow();
    }
  });

  it('lets a share holder write when the flag is on or unset', () => {
    const svc = itemsService(true);
    for (const layer of [{ editingEnabled: true }, {}]) {
      expect(() =>
        svc.assertLayerEditingEnabled(holder as never, layerItem(true) as never, layer),
      ).not.toThrow();
    }
  });
});

describe('the async import job honours a frozen layer', () => {
  it('is not enqueued for a share holder', async () => {
    const staging = { getStaging: jest.fn() };
    const jobs = { enqueue: jest.fn() };
    const controller = new ImportJobsController(
      jobs as never,
      itemsService(false),
      staging as never,
    );
    await expect(
      controller.createJob(holder as never, ITEM, 'L1', {
        stagingId: '0123abcd-0000-4000-8000-00000000cafe',
        sourceLayerName: 'x',
        mode: 'append',
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });
});
