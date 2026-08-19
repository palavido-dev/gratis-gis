// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The authed OGC Features surface: what its authorization must hold.
 *
 * The spec-shaped envelope (paging, CRS, links) is shared with the
 * public controller through features-core and pinned by that
 * controller's spec. What is pinned HERE is what makes this surface
 * safe to expose at all: reads resolve through ItemsService.get (404
 * for the unreadable), the collection list filters with
 * visibleWhere, and every feature read carries the caller's share
 * geo limit and row scope down to the engine. Any of these missing
 * would make this surface see MORE than the portal's own reads.
 */
import { NotFoundException } from '@nestjs/common';

import { AuthedOgcFeaturesController } from './authed-features.controller.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

const USER = { id: 'u-1', orgId: 'org-1', orgRole: 'viewer' } as AuthUser;
const ITEM_ID = '22222222-2222-7222-8222-222222222222';

const req = {
  protocol: 'https',
  headers: {},
  // `query` is part of every real Express request; the handlers read
  // it to refuse undeclared parameters, so the stand-in must carry it
  // or the mock diverges from the thing it mocks.
  query: {},
  get: () => 'gratisgis.test',
} as never;

function v3Item(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    type: 'data_layer',
    title: 'Parcels',
    description: 'desc',
    tags: ['a'],
    license: null,
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    shares: [{ principalType: 'group', principalId: 'g-1' }],
    data: {
      version: 3,
      layers: [
        { id: 'parcels', label: 'Parcels', geometryType: 'Polygon' },
        {
          id: 'summary',
          label: 'Summary',
          geometryType: null,
          editingPolicy: 'own-rows-only',
        },
      ],
    },
    ...overrides,
  };
}

interface Fakes {
  itemsGet: jest.Mock;
  geoLimitFor: jest.Mock;
  effectiveRowScope: jest.Mock;
  visibleWhere: jest.Mock;
  listFeatures: jest.Mock;
  findMany: jest.Mock;
}

function makeController(overrides: Partial<Fakes> = {}) {
  const fakes: Fakes = {
    itemsGet: jest.fn(async () => v3Item()),
    geoLimitFor: jest.fn(async () => null),
    effectiveRowScope: jest.fn(() => 'all'),
    visibleWhere: jest.fn(() => ({ tag: 'visible-where-predicate' })),
    listFeatures: jest.fn(async () => ({ features: [] })),
    findMany: jest.fn(async () => []),
    ...overrides,
  };
  const controller = new AuthedOgcFeaturesController(
    { item: { findMany: fakes.findMany } } as never,
    { get: fakes.itemsGet } as never,
    {
      geoLimitFor: fakes.geoLimitFor,
      effectiveRowScope: fakes.effectiveRowScope,
      visibleWhere: fakes.visibleWhere,
    } as never,
    { listFeatures: fakes.listFeatures } as never,
  );
  return { controller, fakes };
}

describe('authorization pipeline', () => {
  it('resolves every read through ItemsService.get', async () => {
    const { controller, fakes } = makeController();
    await controller.items(USER, req, ITEM_ID);
    expect(fakes.itemsGet).toHaveBeenCalledWith(USER, ITEM_ID);
  });

  it('an unreadable item stays a 404, never a listing', async () => {
    // ItemsService.get answers 404 for items the caller must not
    // learn exist; the controller must pass that through untouched.
    const { controller } = makeController({
      itemsGet: jest.fn(async () => {
        throw new NotFoundException('Item not found');
      }),
    });
    await expect(controller.items(USER, req, ITEM_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('a non-data-layer item is not a collection', async () => {
    const { controller } = makeController({
      itemsGet: jest.fn(async () => v3Item({ type: 'map' })),
    });
    await expect(
      controller.collection(USER, req, ITEM_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('the collection list filters with visibleWhere', async () => {
    const { controller, fakes } = makeController();
    await controller.collections(USER, req);
    expect(fakes.visibleWhere).toHaveBeenCalledWith(USER);
    const where = fakes.findMany.mock.calls[0]![0].where;
    expect(where.AND).toEqual([
      { type: 'data_layer' },
      { tag: 'visible-where-predicate' },
    ]);
  });
});

describe('clips reach the engine', () => {
  it('a share geo limit rides every items read', async () => {
    const clip = { type: 'Polygon', coordinates: [] };
    const { controller, fakes } = makeController({
      geoLimitFor: jest.fn(async () => clip),
    });
    await controller.items(USER, req, ITEM_ID);
    const opts = fakes.listFeatures.mock.calls[0]![2];
    expect(opts.geoLimit).toBe(clip);
  });

  it('own-rows scope narrows the read to the caller', async () => {
    const { controller, fakes } = makeController({
      effectiveRowScope: jest.fn(() => 'own'),
    });
    await controller.items(USER, req, ITEM_ID);
    const opts = fakes.listFeatures.mock.calls[0]![2];
    expect(opts.ownRowsOnly).toEqual({ userId: USER.id });
  });

  it('single-feature reads carry the same clips', async () => {
    // Without this, a caller who knows a feature id walks features
    // outside their share geo limit one at a time.
    const clip = { type: 'Polygon', coordinates: [] };
    const { controller, fakes } = makeController({
      geoLimitFor: jest.fn(async () => clip),
      listFeatures: jest.fn(async () => ({
        features: [{ id: 'f-1', geometry: null }],
      })),
    });
    await controller.feature(USER, req, ITEM_ID, 'f-1');
    const opts = fakes.listFeatures.mock.calls[0]![2];
    expect(opts.geoLimit).toBe(clip);
    expect(opts.entity).toBe('f-1');
  });

  it('the row scope consults the layer editing policy', async () => {
    const { controller, fakes } = makeController();
    await controller.items(USER, req, `${ITEM_ID}__summary`);
    expect(fakes.effectiveRowScope).toHaveBeenCalledWith(
      USER,
      expect.anything(),
      expect.anything(),
      'own-rows-only',
      'read',
    );
  });

  it('a table sublayer reads as a table', async () => {
    const { controller, fakes } = makeController();
    await controller.items(USER, req, `${ITEM_ID}__summary`);
    const opts = fakes.listFeatures.mock.calls[0]![2];
    expect(opts.isTable).toBe(true);
  });
});

describe('collection shape', () => {
  it('a bare item id resolves the first layer', async () => {
    const { controller, fakes } = makeController();
    await controller.items(USER, req, ITEM_ID);
    expect(fakes.listFeatures.mock.calls[0]![1]).toBe('parcels');
  });

  it('an explicit layer key resolves that layer', async () => {
    const { controller, fakes } = makeController();
    await controller.items(USER, req, `${ITEM_ID}__summary`);
    expect(fakes.listFeatures.mock.calls[0]![1]).toBe('summary');
  });

  it('an unknown layer key is a 404', async () => {
    const { controller } = makeController();
    await expect(
      controller.items(USER, req, `${ITEM_ID}__nope`),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('the landing page links conformance and collections', () => {
    const { controller } = makeController();
    const doc = controller.landing(req) as {
      links: Array<{ rel: string; href: string }>;
    };
    const rels = doc.links.map((l) => l.rel);
    expect(rels).toContain('data');
    expect(
      doc.links.every((l) => l.href.includes('/api/ogc')),
    ).toBe(true);
  });
});
