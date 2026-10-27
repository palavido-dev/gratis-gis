// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { ArcgisCopyToDataLayerService } from './arcgis-copy-to-data-layer.service.js';

function makeUser(): AuthUser {
  return {
    id: 'u1',
    orgId: 'org-1',
    orgSlug: 'org-1',
    username: 'alice',
    email: 'alice@example.com',
    orgRole: 'contributor',
    groupIds: [],
    capabilities: new Set(),
  } as AuthUser;
}

describe('ArcgisCopyToDataLayerService', () => {
  function makeSvc(opts: {
    item: {
      type: string;
      title: string;
      access: string;
      data: Record<string, unknown>;
    };
    runSelected?: jest.Mock;
    getCredential?: jest.Mock;
  }) {
    const items = {
      assertCanEdit: jest.fn(async () => undefined),
      get: jest.fn(async () => opts.item),
    };
    const credentials = {
      getCredentialForProxy: opts.getCredential ?? jest.fn(),
    };
    const hostedFs = {
      runSelected:
        opts.runSelected ??
        jest.fn(async () => ({
          portalItemId: 'dl-1',
          layerCount: 1,
          featuresInserted: 3,
          attachmentsCopied: 0,
          warnings: [],
          agoLayerIdToSublayerKey: { 0: 'layer_0' },
          truncated: false,
        })),
    };
    const svc = new ArcgisCopyToDataLayerService(
      items as never,
      credentials as never,
      hostedFs as never,
    );
    return { svc, items, hostedFs, credentials };
  }

  it('copies selected FeatureServer layers via hosted-fs', async () => {
    const { svc, hostedFs } = makeSvc({
      item: {
        type: 'arcgis_service',
        title: 'Parcels',
        access: 'private',
        data: {
          url: 'https://example.com/arcgis/rest/services/Parcels/FeatureServer',
          serviceType: 'FeatureServer',
          selectedLayerIds: [0, 2],
        },
      },
    });
    const out = await svc.copy({ user: makeUser(), itemId: 'item-1' });
    expect(out.portalItemId).toBe('dl-1');
    expect(hostedFs.runSelected).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceUrl:
          'https://example.com/arcgis/rest/services/Parcels/FeatureServer',
        layerIds: [0, 2],
        title: 'Parcels (copy)',
        copyAttachments: false,
      }),
    );
  });

  it('refuses non-arcgis items', async () => {
    const { svc } = makeSvc({
      item: {
        type: 'data_layer',
        title: 'x',
        access: 'private',
        data: {},
      },
    });
    await expect(
      svc.copy({ user: makeUser(), itemId: 'item-1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses MapServer without a FeatureServer twin path shape', async () => {
    const { svc } = makeSvc({
      item: {
        type: 'arcgis_service',
        title: 'Tiles',
        access: 'private',
        data: {
          url: 'https://example.com/arcgis/rest/services/Tiles/SomethingElse',
          serviceType: 'MapServer',
          selectedLayerIds: [0],
        },
      },
    });
    await expect(
      svc.copy({ user: makeUser(), itemId: 'item-1' }),
    ).rejects.toThrow(/FeatureServer/i);
  });

  it('refuses empty selection', async () => {
    const { svc } = makeSvc({
      item: {
        type: 'arcgis_service',
        title: 'Empty',
        access: 'private',
        data: {
          url: 'https://example.com/arcgis/rest/services/Parcels/FeatureServer',
          serviceType: 'FeatureServer',
          selectedLayerIds: [],
        },
      },
    });
    await expect(
      svc.copy({ user: makeUser(), itemId: 'item-1' }),
    ).rejects.toThrow(/Select at least one layer/i);
  });
});
