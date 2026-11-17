// SPDX-License-Identifier: AGPL-3.0-or-later
import { NotFoundException } from '@nestjs/common';

import { DataLayerAttachmentsService } from './attachments.service.js';
import {
  assertAttachmentAccess,
  assertFeatureVisible,
  type AttachmentAccess,
} from './attachments-access.js';

/**
 * Attachments hang off features, so a caller reaches an attachment
 * exactly when they can reach its feature. A share limited to the
 * caller's own rows or to an area used to list, download and delete
 * every attachment on the layer.
 */

const VISIBLE = '00000000-0000-4000-8000-000000000001';
const HIDDEN = '00000000-0000-4000-8000-000000000002';
const CLIP = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };

function row(featureId: string, id: string) {
  return {
    id,
    featureId,
    fileName: `${id}.jpg`,
    mime: 'image/jpeg',
    sizeBytes: 1,
    storageKey: `feature-attachment/${id}`,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    createdBy: 'u',
  };
}

function engineSeeing(visible: string[]) {
  return {
    listFeatures: jest.fn(async (args: { entityIds?: string[]; entity?: string }) => ({
      features: (args.entityIds ?? (args.entity ? [args.entity] : []))
        .filter((id) => visible.includes(id))
        .map((id) => ({ id, properties: {} })),
    })),
  };
}

const limited: AttachmentAccess = {
  shareScope: { geoLimit: CLIP as never },
  limited: true,
  isTable: false,
};

describe('attachment scope', () => {
  it('?all=1 lists only attachments of features the caller can read', async () => {
    const engine = engineSeeing([VISIBLE]);
    const prisma = {
      featureAttachment: {
        findMany: jest.fn(async () => [row(VISIBLE, 'a'), row(HIDDEN, 'b')]),
      },
    };
    const svc = new DataLayerAttachmentsService(
      prisma as never,
      {} as never,
      engine as never,
    );
    const groups = await svc.listForLayer('item', 'layer', {
      all: true,
      access: limited,
    });
    expect(groups.map((g) => g.featureId)).toEqual([VISIBLE]);
    expect(engine.listFeatures).toHaveBeenCalledWith(
      expect.objectContaining({ geoLimit: CLIP, entityIds: [VISIBLE, HIDDEN] }),
    );
    // The link is built from the stored key, not a client-sent URL.
    expect(JSON.stringify(groups)).toContain('/api/portal/storage/private/feature-attachment/a');
  });

  it('explicit featureIds outside the scope are dropped', async () => {
    const engine = engineSeeing([VISIBLE]);
    const prisma = {
      featureAttachment: {
        findMany: jest.fn(async () => [row(VISIBLE, 'a'), row(HIDDEN, 'b')]),
      },
    };
    const svc = new DataLayerAttachmentsService(
      prisma as never,
      {} as never,
      engine as never,
    );
    const groups = await svc.listForLayer('item', 'layer', {
      featureIds: [HIDDEN, VISIBLE],
      access: limited,
    });
    expect(groups.map((g) => g.featureId)).toEqual([VISIBLE]);
  });

  it('download, remove and the per-feature list 404 outside the scope', async () => {
    const engine = engineSeeing([VISIBLE]);
    await expect(
      assertFeatureVisible(engine as never, 'item', 'layer', HIDDEN, limited),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      assertFeatureVisible(engine as never, 'item', 'layer', VISIBLE, limited),
    ).resolves.toBeUndefined();
  });

  it('register checks the feature under the caller edit scope', async () => {
    const engine = engineSeeing([VISIBLE]);
    // The key was issued to this caller, so only the scope can refuse.
    const prisma = {
      storageUploadGrant: {
        findMany: jest.fn(async () => [{ key: 'feature-attachment/abc' }]),
      },
    };
    const svc = new DataLayerAttachmentsService(
      prisma as never,
      { headObjectSize: jest.fn() } as never,
      engine as never,
    );
    await expect(
      svc.register(
        'item',
        'layer',
        HIDDEN,
        {
          fileName: 'x.jpg',
          mime: 'image/jpeg',
          sizeBytes: 1,
          storageKey: 'feature-attachment/abc',
          storageUrl: 'https://x.test/abc',
        },
        'u',
        limited,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('access resolves the edit scope with the layer policy on writes', async () => {
    const featureScopeFor = jest.fn(async () => ({
      geoLimit: null,
      rowScope: 'own' as const,
      userId: 'u',
    }));
    const items = {
      get: jest.fn(async () => ({
        type: 'data_layer',
        data: {
          version: 3,
          layers: [{ id: 'layer', editingPolicy: 'own-rows-only', geometryType: 'Point' }],
        },
        shares: [],
      })),
      assertCanEdit: jest.fn(async () => undefined),
      assertLayerEditingEnabled: jest.fn(),
    };
    const access = await assertAttachmentAccess(
      items as never,
      { featureScopeFor, canDownload: () => true } as never,
      { id: 'u' } as never,
      'item',
      'layer',
      'write',
    );
    expect(featureScopeFor).toHaveBeenCalledWith(
      { id: 'u' },
      expect.anything(),
      [],
      { action: 'edit', layerPolicy: 'own-rows-only' },
    );
    expect(access).toEqual({
      shareScope: { ownRowsOnly: { userId: 'u' } },
      limited: true,
      isTable: false,
    });
  });
});
