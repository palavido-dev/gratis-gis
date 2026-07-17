// SPDX-License-Identifier: AGPL-3.0-or-later
import { ForbiddenException } from '@nestjs/common';
import type { Response } from 'express';

import { DataLayerFeaturesController } from './features.controller.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

/**
 * Download-tier gate coverage for the GeoParquet export (#174).
 *
 * The endpoint is the FIRST enforcer of SharingService.canDownload:
 * the tier has existed since #32 and the item payload surfaces it,
 * but until this route nothing on the server refused a bulk read
 * over it. The spec drives the controller directly with fakes (the
 * same style as admin-users.controller.spec.ts) and pins two
 * behaviors: a caller without the tier gets a 403, and the export
 * pipeline is never started for them.
 */

const ITEM_ID = '11111111-1111-7111-8111-111111111111';
const LAYER_ID = 'facilities';

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-viewer',
    orgId: 'org-1',
    orgSlug: 'org-1',
    username: 'viewer',
    email: 'viewer@example.test',
    orgRole: 'viewer',
    groupIds: [],
    ...overrides,
  } as unknown as AuthUser;
}

function makeController(opts: { canDownload: boolean }) {
  // Minimal v3 data_layer item: enough for assertV3Layer to accept
  // the layer and for the filename helper to resolve labels.
  const item = {
    id: ITEM_ID,
    type: 'data_layer',
    title: 'Sample Facilities',
    ownerId: 'user-owner',
    orgId: 'org-1',
    access: 'private',
    data: {
      version: 3,
      layers: [
        {
          id: LAYER_ID,
          name: 'facilities',
          label: 'Facilities',
          geometryType: 'point',
          fields: [{ name: 'name', type: 'string', label: 'Name' }],
        },
      ],
    },
    shares: [],
  };

  const items = {
    get: jest.fn(async () => item),
    assertCanEdit: jest.fn(async () => undefined),
  };
  const sharing = {
    canDownload: jest.fn(() => opts.canDownload),
    geoLimitFor: jest.fn(async () => null),
    effectiveRowScope: jest.fn(() => 'all' as const),
  };
  const iterateFeatures = jest.fn(async function* () {
    yield [];
  });
  const v3 = { iterateFeatures };

  const controller = new DataLayerFeaturesController(
    items as unknown as ConstructorParameters<
      typeof DataLayerFeaturesController
    >[0],
    sharing as unknown as ConstructorParameters<
      typeof DataLayerFeaturesController
    >[1],
    v3 as unknown as ConstructorParameters<
      typeof DataLayerFeaturesController
    >[2],
    {} as ConstructorParameters<typeof DataLayerFeaturesController>[3],
    {} as ConstructorParameters<typeof DataLayerFeaturesController>[4],
    {} as ConstructorParameters<typeof DataLayerFeaturesController>[5],
  );
  return { controller, items, sharing, iterateFeatures };
}

function makeRes(): Response {
  return {
    setHeader: jest.fn(),
    destroy: jest.fn(),
  } as unknown as Response;
}

describe('DataLayerFeaturesController.geoparquet download gate', () => {
  it('rejects with 403 when canDownload says no', async () => {
    const { controller, items, sharing, iterateFeatures } = makeController({
      canDownload: false,
    });

    await expect(
      controller.geoparquet(makeRes(), makeUser(), ITEM_ID, LAYER_ID),
    ).rejects.toThrow(ForbiddenException);

    // Visibility ran first (a reader who cannot even see the item
    // still gets assertV3Layer's 404, not this 403)...
    expect(items.get).toHaveBeenCalled();
    // ...the decision consulted the real policy surface...
    expect(sharing.canDownload).toHaveBeenCalledTimes(1);
    // ...and no feature ever left the engine for the denied caller.
    expect(iterateFeatures).not.toHaveBeenCalled();
  });

  it('gates the csv route on the same download tier', async () => {
    // Originally csv kept its historical read-only gating and this
    // spec pinned that; the consistency decision after #174 gates
    // every attachment-download endpoint identically. /geojson is
    // deliberately NOT gated (map overlay source, read tier).
    const { controller, sharing } = makeController({ canDownload: false });
    const res = makeRes();
    const send = jest.fn();
    (res as unknown as { send: jest.Mock }).send = send;
    const listFeatures = jest
      .spyOn(controller, 'listFeatures')
      .mockResolvedValue({ type: 'FeatureCollection', features: [] });

    await expect(
      controller.csv(res, makeUser(), ITEM_ID, LAYER_ID),
    ).rejects.toThrow(ForbiddenException);

    expect(sharing.canDownload).toHaveBeenCalledTimes(1);
    // The denied caller never pulls rows and never gets a body.
    expect(listFeatures).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    listFeatures.mockRestore();
  });
});
