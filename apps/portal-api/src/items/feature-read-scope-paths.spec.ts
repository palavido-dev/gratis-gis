// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ItemsService } from './items.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { SharingService } from './sharing.service.js';
import { AnalysisService } from '../analysis/analysis.service.js';
import { RecipeRunnerService } from '../tools/recipe-runner.service.js';
import { GeocodingService } from '../geocoding/geocoding.service.js';

/**
 * Three paths read a layer's rows or extent outside the engine's
 * feature routes: zonal statistics (zones), a recipe's layer AOI
 * (extent) and the internal geocoder (candidates). Each must apply
 * the caller's share scope from the shared resolver, or a geo-limited
 * or own-rows reader learns rows outside their share.
 */

const LAYER = '00000000-0000-4000-8000-0000000000e1';
const POLY = {
  type: 'Polygon',
  coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
};

const reader = {
  id: 'reader',
  orgId: 'org-1',
  orgRole: 'contributor',
  groupIds: [],
  capabilities: new Set(['can_publish_items']),
};

function viewShare(extra: Record<string, unknown> = {}) {
  return {
    itemId: LAYER,
    principalType: 'user',
    principalId: 'reader',
    permission: 'view',
    rowScope: 'all',
    editRowScope: null,
    expiresAt: null,
    geoLimit: null,
    geoBoundaryId: null,
    ...extra,
  };
}

function dataLayer(shares: unknown[]) {
  return {
    id: LAYER,
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
      layers: [
        {
          id: 'L1',
          geometryType: 'polygon',
          fields: [{ name: 'owner', type: 'string' }],
        },
      ],
    },
    shares,
  };
}

/** A real ItemsService scope surface over a fixed item. */
function itemsWith(item: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const svc = Object.create(ItemsService.prototype) as ItemsService;
  Object.assign(svc, {
    prisma: { itemShare: { findMany: async () => item.shares } },
    sharing: new SharingService(undefined as never, new PolicyService()),
  });
  (svc as unknown as { get: unknown }).get = jest.fn(
    async (_u: unknown, id: string) =>
      (extra[id] as Record<string, unknown> | undefined) ?? item,
  );
  return svc;
}

describe('zonal statistics', () => {
  function run(shares: unknown[]) {
    const tile = {
      id: 'tile',
      type: 'tile_layer',
      data: { cogStorageKey: 'k.tif' },
    };
    const items = itemsWith(dataLayer(shares), { tile });
    const listFeatures = jest.fn(async () => ({
      type: 'FeatureCollection',
      features: [],
    }));
    const svc = Object.create(AnalysisService.prototype) as AnalysisService;
    Object.assign(svc, { items, features: { listFeatures } });
    (svc as unknown as { assertServerTier: unknown }).assertServerTier = () =>
      undefined;
    return { svc, listFeatures };
  }

  it('reads zones through the caller geo limit', async () => {
    const { svc, listFeatures } = run([viewShare({ geoLimit: POLY })]);
    await expect(
      svc.createZonalStatsJob(reader as never, 'tile', {
        zoneItemId: LAYER,
        zoneLayerKey: 'L1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(listFeatures).toHaveBeenCalledWith(
      LAYER,
      'L1',
      expect.objectContaining({ geoLimit: POLY }),
    );
  });

  it('reads zones through the caller own-rows scope', async () => {
    const { svc, listFeatures } = run([viewShare({ rowScope: 'own' })]);
    await expect(
      svc.createZonalStatsJob(reader as never, 'tile', {
        zoneItemId: LAYER,
        zoneLayerKey: 'L1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(listFeatures).toHaveBeenCalledWith(
      LAYER,
      'L1',
      expect.objectContaining({ ownRowsOnly: { userId: 'reader' } }),
    );
  });
});

describe('recipe layer AOI extent', () => {
  function run(shares: unknown[]) {
    const items = itemsWith(dataLayer(shares));
    const $queryRaw = jest.fn(async () => [{ extent: 'BOX(0 0,1 1)' }]);
    const svc = Object.create(RecipeRunnerService.prototype) as RecipeRunnerService;
    Object.assign(svc, { items, prisma: { $queryRaw } });
    const computeAoiBbox = (
      svc as unknown as {
        computeAoiBbox: (u: unknown, v: unknown) => Promise<unknown>;
      }
    ).computeAoiBbox.bind(svc);
    return { computeAoiBbox, $queryRaw };
  }

  it('refuses a limited reader without reading the extent', async () => {
    const { computeAoiBbox, $queryRaw } = run([viewShare({ geoLimit: POLY })]);
    await expect(
      computeAoiBbox(reader, { kind: 'data_layer', itemId: LAYER, layerKey: 'L1' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it('still reads the extent for an unlimited reader', async () => {
    const { computeAoiBbox } = run([viewShare()]);
    await expect(
      computeAoiBbox(reader, { kind: 'data_layer', itemId: LAYER, layerKey: 'L1' }),
    ).resolves.toEqual([0, 0, 1, 1]);
  });
});

describe('internal geocoder', () => {
  function run(shares: unknown[]) {
    const geocoder = {
      id: 'geo',
      type: 'geocoding_service',
      data: {
        version: 1,
        sourceLayerId: LAYER,
        sourceSublayerId: 'L1',
        searchFields: [{ name: 'owner' }],
      },
    };
    const items = itemsWith(dataLayer(shares), { geo: geocoder });
    const calls: Prisma.Sql[] = [];
    const svc = Object.create(GeocodingService.prototype) as GeocodingService;
    Object.assign(svc, {
      items,
      prisma: {
        $executeRaw: async () => 0,
        $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
          calls.push(Prisma.sql(strings, ...values));
          return [];
        },
      },
    });
    return { svc, calls };
  }

  it('narrows candidates to the caller geo limit', async () => {
    const { svc, calls } = run([viewShare({ geoLimit: POLY })]);
    await svc.search(reader as never, 'geo', 'smith');
    const q = calls.at(-1)!;
    expect(q.sql).toMatch(/ST_Intersects\(geom/);
    expect(q.values).toContain(JSON.stringify(POLY));
  });

  it('narrows candidates to rows whose latest create is the caller', async () => {
    const { svc, calls } = run([viewShare({ rowScope: 'own' })]);
    await svc.search(reader as never, 'geo', 'smith');
    const q = calls.at(-1)!;
    expect(q.sql).toMatch(/c\.kind = 'create'/);
    expect(q.values).toContain('reader');
  });

  it('adds nothing for an unlimited reader', async () => {
    const { svc, calls } = run([viewShare()]);
    await svc.search(reader as never, 'geo', 'smith');
    const q = calls.at(-1)!;
    expect(q.sql).not.toMatch(/c\.kind = 'create'|ST_Intersects\(geom/);
  });
});
