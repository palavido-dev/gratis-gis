// SPDX-License-Identifier: AGPL-3.0-or-later
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Request, Response } from 'express';

import { DataLayerFeaturesController } from './features.controller.js';
import { PublicController } from '../public/public.controller.js';
import { OgcTilesController } from '../public/ogc/tiles.controller.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Per-layer tile settings and TileJSON, through every tile route:
 * the authenticated one, the anonymous portal-shaped one and the OGC
 * one. Drives the controllers with fakes, in the style of
 * features.controller.spec.ts, and pins:
 *
 *  - the settings reach the tile service (trimmed fields plus what
 *    the map names in `include`, the lowered cap, the zoom range);
 *  - Cache-Control takes the setting's max-age but keeps the route's
 *    visibility, so the authenticated route is never `public`;
 *  - TileJSON goes through the same access check as the tiles, and a
 *    private layer answers exactly as its tiles do (denied).
 */

const ITEM_ID = '11111111-1111-7111-8111-111111111111';
const LAYER_ID = 'parcels';

const LAYER = {
  id: LAYER_ID,
  name: 'parcels',
  label: 'Parcels',
  geometryType: 'polygon',
  bbox: [-80, 38, -79, 39],
  fields: [
    { name: 'name', type: 'string' },
    { name: 'pop', type: 'number' },
    { name: 'zone', type: 'string' },
  ],
  tiles: {
    fields: ['name'],
    minZoom: 6,
    maxZoom: 18,
    maxFeatures: 250,
    cacheMaxAge: 900,
  },
};

function item(layer: Record<string, unknown> = LAYER) {
  return {
    id: ITEM_ID,
    type: 'data_layer',
    title: 'County',
    description: 'County parcels',
    ownerId: 'owner',
    orgId: 'org-1',
    access: 'private',
    bbox: [],
    data: { version: 3, layers: [layer] },
    shares: [],
  };
}

function makeUser(): AuthUser {
  return {
    id: 'viewer',
    orgId: 'org-1',
    orgSlug: 'org-1',
    username: 'viewer',
    email: 'v@example.test',
    orgRole: 'viewer',
    groupIds: [],
  } as unknown as AuthUser;
}

interface FakeRes {
  headers: Record<string, string>;
  statusCode: number;
  body: unknown;
  setHeader: jest.Mock;
  status: jest.Mock;
  end: jest.Mock;
  json: jest.Mock;
}

function makeRes(): FakeRes {
  const headers: Record<string, string> = {};
  const res: FakeRes = {
    headers,
    statusCode: 200,
    body: undefined as unknown,
    setHeader: jest.fn((k: string, v: string) => {
      headers[k] = v;
    }),
    status: jest.fn((c: number): FakeRes => {
      res.statusCode = c;
      return res;
    }),
    end: jest.fn((b?: unknown) => {
      res.body = b;
    }),
    json: jest.fn((b: unknown) => {
      res.body = b;
    }),
  };
  return res;
}

const req = { headers: {} } as unknown as Request;

function makeAuthed(opts: {
  getItem?: () => Promise<unknown>;
  geoLimit?: unknown;
  rowScope?: 'all' | 'own';
}) {
  const mvtTile = jest.fn(async () => ({
    mvt: Buffer.from([1, 2, 3]),
    etag: '"e"',
  }));
  const items = {
    get: jest.fn(opts.getItem ?? (async () => item())),
    assertCanEdit: jest.fn(),
  };
  const sharing = {
    geoLimitFor: jest.fn(async () => opts.geoLimit ?? null),
    effectiveRowScope: jest.fn(() => opts.rowScope ?? 'all'),
  };
  type Ctor = ConstructorParameters<typeof DataLayerFeaturesController>;
  const controller = new DataLayerFeaturesController(
    items as unknown as Ctor[0],
    sharing as unknown as Ctor[1],
    { mvtTile } as unknown as Ctor[2],
    {} as Ctor[3],
    {} as Ctor[4],
    {} as Ctor[5],
  );
  return { controller, mvtTile, items };
}

describe('authenticated tile route with tile settings', () => {
  const prev = process.env.PORTAL_BASE_URL;
  beforeEach(() => {
    process.env.PORTAL_BASE_URL = 'https://maps.example.org';
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.PORTAL_BASE_URL;
    else process.env.PORTAL_BASE_URL = prev;
  });

  it('passes the trimmed field list, the map\'s fields, the cap and the zoom range', async () => {
    const { controller, mvtTile } = makeAuthed({});
    const res = makeRes();
    await controller.tile(
      req,
      res as unknown as Response,
      makeUser(),
      ITEM_ID,
      LAYER_ID,
      '10',
      '1',
      '2',
      undefined,
      undefined,
      undefined,
      'zone,bogus',
    );
    const opts = (mvtTile.mock.calls[0] as unknown[])[5] as Record<string, unknown>;
    expect(opts.fields).toEqual([
      { name: 'name', type: 'string' },
      { name: 'zone', type: 'string' },
    ]);
    expect(opts.maxFeaturesPerTile).toBe(250);
    expect(opts.zoomRange).toEqual({ min: 6, max: 18 });
    expect(res.headers['Cache-Control']).toBe('private, max-age=900');
  });

  it('is unchanged for a layer without settings', async () => {
    const { tiles: _t, ...plain } = LAYER;
    void _t;
    const { controller, mvtTile } = makeAuthed({
      getItem: async () => item(plain),
    });
    const res = makeRes();
    await controller.tile(
      req,
      res as unknown as Response,
      makeUser(),
      ITEM_ID,
      LAYER_ID,
      '10',
      '1',
      '2',
      undefined,
      undefined,
      undefined,
      'zone',
    );
    const opts = (mvtTile.mock.calls[0] as unknown[])[5] as Record<string, unknown>;
    expect(opts.fields).toEqual(LAYER.fields);
    expect('maxFeaturesPerTile' in opts).toBe(false);
    expect('zoomRange' in opts).toBe(false);
    expect(res.headers['Cache-Control']).toBe('private, max-age=60');
  });

  it('serves TileJSON through the same read check', async () => {
    const { controller, items } = makeAuthed({});
    const res = makeRes();
    await controller.tileJson(res as unknown as Response, makeUser(), ITEM_ID, LAYER_ID);
    expect(items.get).toHaveBeenCalledWith(expect.anything(), ITEM_ID);
    expect(res.body).toMatchObject({
      tilejson: '3.0.0',
      name: 'County',
      tiles: [
        `https://maps.example.org/api/items/${ITEM_ID}/layers/${LAYER_ID}/tile/{z}/{x}/{y}.mvt`,
      ],
      minzoom: 6,
      maxzoom: 18,
      bounds: [-80, 38, -79, 39],
      vector_layers: [
        { id: 'features', fields: { _global_id: 'String', name: 'String' } },
      ],
    });
    expect(res.headers['Cache-Control']).toBe('private, no-cache');
  });

  it('denies TileJSON for a layer the caller cannot read', async () => {
    const { controller } = makeAuthed({
      getItem: async () => {
        throw new ForbiddenException('no');
      },
    });
    const res = makeRes();
    await expect(
      controller.tileJson(res as unknown as Response, makeUser(), ITEM_ID, LAYER_ID),
    ).rejects.toThrow(ForbiddenException);
    expect(res.json).not.toHaveBeenCalled();
  });

  it('leaves the extent out for a geo-limited or row-scoped viewer', async () => {
    for (const narrowing of [
      { geoLimit: { type: 'Polygon', coordinates: [] } },
      { rowScope: 'own' as const },
    ]) {
      const { controller } = makeAuthed(narrowing);
      const res = makeRes();
      await controller.tileJson(res as unknown as Response, makeUser(), ITEM_ID, LAYER_ID);
      expect('bounds' in (res.body as object)).toBe(false);
    }
  });
});

describe('anonymous portal tile route and TileJSON', () => {
  function makePublic(row: unknown) {
    const findFirst = jest.fn().mockResolvedValue(row);
    const mvtTile = jest.fn(async () => ({ mvt: Buffer.from([1]), etag: '"e"' }));
    const controller = new PublicController(
      { item: { findFirst } } as unknown as PrismaService,
      { mvtTile } as never,
    );
    return { controller, findFirst, mvtTile };
  }

  it('denies TileJSON for a private layer, with the same public-only query as the tiles', async () => {
    // A private item is not found by an access='public' query.
    const { controller, findFirst } = makePublic(null);
    const res = makeRes();
    await expect(
      controller.layerTileJson(res as unknown as Response, ITEM_ID, LAYER_ID),
    ).rejects.toThrow(NotFoundException);
    expect(findFirst.mock.calls[0]![0].where).toMatchObject({
      id: ITEM_ID,
      access: 'public',
      deletedAt: null,
    });
    expect(res.json).not.toHaveBeenCalled();
  });

  it('describes a public layer, without bounds under a tier clip', async () => {
    const row = { ...item(), access: 'public', publicGeoBoundaryId: null };
    const { controller } = makePublic(row);
    const res = makeRes();
    await controller.layerTileJson(res as unknown as Response, ITEM_ID, LAYER_ID);
    expect(res.body).toMatchObject({
      tiles: [expect.stringContaining(`/api/public/items/${ITEM_ID}/layers/${LAYER_ID}/tile/{z}/{x}/{y}.mvt`)],
      bounds: [-80, 38, -79, 39],
    });
    expect(res.headers['Cache-Control']).toBe('public, max-age=300');

    const clipped = makePublic({ ...row, publicGeoBoundaryId: 'b1' });
    const res2 = makeRes();
    await clipped.controller.layerTileJson(res2 as unknown as Response, ITEM_ID, LAYER_ID);
    expect('bounds' in (res2.body as object)).toBe(false);
  });

  it('applies the settings to the anonymous tile', async () => {
    const row = { ...item(), access: 'public', publicGeoBoundaryId: null };
    const { controller, mvtTile } = makePublic(row);
    const res = makeRes();
    await controller.layerTile(
      req,
      res as unknown as Response,
      ITEM_ID,
      LAYER_ID,
      '10',
      '1',
      '2',
      undefined,
      undefined,
      'pop',
    );
    const opts = (mvtTile.mock.calls[0] as unknown[])[5] as Record<string, unknown>;
    expect(opts.fields).toEqual([
      { name: 'name', type: 'string' },
      { name: 'pop', type: 'number' },
    ]);
    expect(opts.maxFeaturesPerTile).toBe(250);
    expect(res.headers['Cache-Control']).toBe('public, max-age=900');
  });
});

describe('OGC tiles TileJSON', () => {
  function makeOgc(row: unknown) {
    const findFirst = jest.fn().mockResolvedValue(row);
    const controller = new OgcTilesController(
      { item: { findFirst } } as unknown as PrismaService,
      {} as never,
    );
    return { controller, findFirst };
  }

  it('denies a private layer', async () => {
    const { controller, findFirst } = makeOgc(null);
    const res = makeRes();
    await expect(
      controller.tileJson(res as unknown as Response, ITEM_ID, 'WebMercatorQuad'),
    ).rejects.toThrow(NotFoundException);
    expect(findFirst.mock.calls[0]![0].where).toMatchObject({ access: 'public' });
  });

  it('describes a public layer and is linked from the tileset', async () => {
    const row = { ...item(), access: 'public', publicGeoBoundaryId: null };
    const { controller } = makeOgc(row);
    const res = makeRes();
    await controller.tileJson(res as unknown as Response, ITEM_ID, 'WebMercatorQuad');
    expect(res.body).toMatchObject({
      tilejson: '3.0.0',
      tiles: [
        expect.stringContaining(
          `/api/public/ogc/collections/${ITEM_ID}/tiles/WebMercatorQuad/{z}/{y}/{x}`,
        ),
      ],
      vector_layers: [{ id: 'features', fields: { _global_id: 'String', name: 'String' } }],
    });
    const tileset = (await controller.tileset(
      { headers: {}, protocol: 'https' } as unknown as Request,
      ITEM_ID,
      'WebMercatorQuad',
    )) as { links: Array<{ rel: string; href: string }>; vectorLayers: Array<{ fields: unknown; minzoom: number }> };
    expect(tileset.links.some((l) => l.rel === 'describedby' && l.href.endsWith('/tilejson.json'))).toBe(true);
    expect(tileset.vectorLayers[0]!.fields).toEqual([{ name: 'name', type: 'string' }]);
    expect(tileset.vectorLayers[0]!.minzoom).toBe(6);
  });
});
