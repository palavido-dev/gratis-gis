// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Request } from 'express';

import { OgcFeaturesController } from './features.controller.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { DataLayerFeaturesService } from '../../data-layer/features.service.js';

/**
 * Paging contract for /collections/:id/items (regression pin).
 *
 * After the limit push-down, the handler fetched exactly
 * offset + limit rows, so `features.length` could never exceed the
 * requested window: the `next` link never emitted and numberMatched
 * reported the fetch cap as if it were the collection size. Clients
 * (QGIS OAPIF, ogcapi-cli) treated every collection as one page.
 *
 * The repaired contract: fetch one probe row past the window; emit
 * `next` exactly when the probe row exists; slice the probe off the
 * response; omit numberMatched entirely (it is OPTIONAL per Part 1
 * 7.18.2 and unknowable without a count query).
 */

const ITEM_ID = '123e4567-e89b-12d3-a456-426614174000';
const LAYER_ID = 'layer-1';

function makeFeatures(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    type: 'Feature',
    id: `id-${i}`,
    geometry: { type: 'Point', coordinates: [-80.1 - i * 0.01, 39.2] },
    properties: { name: `f${i}` },
  }));
}

function makeController(featureCount: number) {
  const item = {
    id: ITEM_ID,
    title: 'Parcels',
    description: 'desc',
    tags: [],
    license: null,
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    data: {
      version: 3,
      layers: [{ id: LAYER_ID, label: 'Parcels' }],
    },
  };
  const prisma = {
    item: {
      findFirst: jest.fn(async () => item),
      findMany: jest.fn(async () => [item]),
    },
  };
  const listFeatures = jest.fn(
    async (_itemId: string, _layerId: string, opts: { limit?: number }) => ({
      type: 'FeatureCollection' as const,
      // Engine semantics: LIMIT caps the row count; fewer rows come
      // back when the layer runs out before the cap.
      features: makeFeatures(Math.min(featureCount, opts.limit ?? Infinity)),
    }),
  );
  const controller = new OgcFeaturesController(
    prisma as unknown as PrismaService,
    { listFeatures } as unknown as DataLayerFeaturesService,
  );
  return { controller, listFeatures };
}

function makeReq(): Request {
  return {
    headers: { host: 'portal.test' },
    protocol: 'http',
  } as unknown as Request;
}

function linkRels(res: { links: Array<Record<string, string>> }) {
  return res.links.map((l) => l.rel);
}

function linkByRel(
  res: { links: Array<Record<string, string>> },
  rel: string,
): Record<string, string> | undefined {
  return res.links.find((l) => l.rel === rel);
}

describe('OgcFeaturesController.items paging', () => {
  it('probes one row past the window and emits the next link when it exists', async () => {
    const { controller, listFeatures } = makeController(10);

    const res = await controller.items(makeReq(), ITEM_ID, undefined, undefined, undefined, '3', '0');

    // The engine fetch asked for offset + limit + 1 (the probe row).
    expect(listFeatures).toHaveBeenCalledWith(
      ITEM_ID,
      LAYER_ID,
      expect.objectContaining({ limit: 4 }),
    );
    // The probe row is not part of the response window.
    expect(res.features).toHaveLength(3);
    expect(res.numberReturned).toBe(3);
    expect(res.features.map((f) => (f as { id?: string }).id)).toEqual([
      'id-0',
      'id-1',
      'id-2',
    ]);
    const next = linkByRel(res, 'next');
    expect(next).toBeDefined();
    const nextUrl = new URL(next!.href!);
    expect(nextUrl.searchParams.get('offset')).toBe('3');
    expect(nextUrl.searchParams.get('limit')).toBe('3');
  });

  it('omits the next link on the final page', async () => {
    // 5 rows total, window offset=3 limit=3 -> rows 3..4 and no more.
    const { controller } = makeController(5);

    const res = await controller.items(makeReq(), ITEM_ID, undefined, undefined, undefined, '3', '3');

    expect(res.features).toHaveLength(2);
    expect(res.numberReturned).toBe(2);
    expect(linkRels(res)).not.toContain('next');
    // Middle pages carry prev back toward the start.
    const prev = linkByRel(res, 'prev');
    expect(prev).toBeDefined();
    expect(new URL(prev!.href!).searchParams.get('offset')).toBe('0');
  });

  it('omits the next link when the collection ends exactly at the window edge', async () => {
    // 3 rows, limit 3: the probe row does not exist, so this IS the
    // last page even though it is completely full.
    const { controller } = makeController(3);

    const res = await controller.items(makeReq(), ITEM_ID, undefined, undefined, undefined, '3', '0');

    expect(res.features).toHaveLength(3);
    expect(linkRels(res)).not.toContain('next');
  });

  it('never reports numberMatched (unknowable without a count query)', async () => {
    const { controller } = makeController(10);

    const res = await controller.items(makeReq(), ITEM_ID, undefined, undefined, undefined, '3', '0');

    expect(res).not.toHaveProperty('numberMatched');
    expect(res.numberReturned).toBe(3);
  });

  it('walks a whole collection through next links without duplication or early stop', async () => {
    // End-to-end paging walk over 7 rows at limit 3: pages of 3, 3,
    // 1, with next links on the first two pages only.
    const { controller } = makeController(7);

    const seen: string[] = [];
    let offset = '0';
    for (let page = 0; page < 10; page++) {
      const res = await controller.items(
        makeReq(),
        ITEM_ID,
        undefined,
        undefined,
        undefined,
        '3',
        offset,
      );
      // The fake returns ids positionally from the start of the
      // layer, mirroring the engine's stable entity ordering; the
      // slice below reflects the offset window.
      for (const f of res.features as Array<{ id?: string }>) {
        seen.push(String(f.id));
      }
      const next = linkByRel(res, 'next');
      if (!next) break;
      offset = new URL(next.href!).searchParams.get('offset')!;
    }

    expect(seen).toEqual([
      'id-0',
      'id-1',
      'id-2',
      'id-3',
      'id-4',
      'id-5',
      'id-6',
    ]);
  });
});
