// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';

import type { PrismaService } from '../../prisma/prisma.service.js';
import { AuthedStacController } from '../../ogc/authed-stac.controller.js';
import type { SharingService } from '../../items/sharing.service.js';
import type { AuthUser } from '../../auth/auth-sync.service.js';
import { PublicStacController } from './stac.controller.js';

/**
 * Request stand-ins carry `query` because the handlers read it for
 * the unknown-parameter refusal; a mock without it diverges from the
 * thing it mocks (the lesson pinned by the #28 spec changes).
 */
function fakeReq(query: Record<string, string> = {}): Request {
  return {
    query,
    headers: { host: 'demo.example' },
    protocol: 'https',
  } as unknown as Request;
}

function makePublic(rows: unknown[] = []) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const findFirst = jest.fn().mockResolvedValue(null);
  const prisma = {
    item: { findMany, findFirst },
  } as unknown as PrismaService;
  return { ctrl: new PublicStacController(prisma), findMany, findFirst };
}

describe('PublicStacController', () => {
  it('landing and /conformance declare the same classes', () => {
    const { ctrl } = makePublic();
    const landing = ctrl.landing(fakeReq()) as unknown as {
      conformsTo: string[];
    };
    const conf = ctrl.conformance() as unknown as { conformsTo: string[] };
    expect(landing.conformsTo).toEqual(conf.conformsTo);
  });

  it('the landing links advertise GET and POST search', () => {
    const { ctrl } = makePublic();
    const landing = ctrl.landing(fakeReq()) as unknown as {
      links: Array<{ rel: string; method?: string }>;
    };
    const search = landing.links.filter((l) => l.rel === 'search');
    expect(search.map((l) => l.method).sort()).toEqual(['GET', 'POST']);
  });

  it('rejects an unknown query parameter on /items by name', async () => {
    // The house rule from #28: an ignored filter is a wrong answer.
    const { ctrl } = makePublic();
    const call = ctrl.items(fakeReq({ 'proj:code': 'x' }), 'rasters');
    await expect(call).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      ctrl.items(fakeReq({ 'proj:code': 'x' }), 'rasters'),
    ).rejects.toThrow(/proj:code/);
  });

  it('rejects an unknown query parameter on /search by name', async () => {
    const { ctrl } = makePublic();
    await expect(
      ctrl.searchGet(fakeReq({ filter: 'x' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown POST body member by name', async () => {
    const { ctrl } = makePublic();
    await expect(
      ctrl.searchPost(fakeReq(), { sortby: [{ field: 'datetime' }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('answers 404 for a collection id it does not serve', async () => {
    const { ctrl } = makePublic();
    await expect(
      ctrl.collection(fakeReq(), 'sentinel-2'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('only ever queries public, live tile_layer rows', async () => {
    const { ctrl, findMany } = makePublic();
    await ctrl.collections(fakeReq());
    const where = findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({
      type: 'tile_layer',
      access: 'public',
      deletedAt: null,
    });
  });

  it('single-item reads keep the public filter in the WHERE', async () => {
    // Fetch-then-check would leak existence through timing and error
    // shape; the filter belongs in the query.
    const { ctrl, findFirst } = makePublic();
    await ctrl
      .item(
        fakeReq(),
        'rasters',
        '11111111-2222-4333-8444-555555555555',
      )
      .catch(() => undefined);
    const where = findFirst.mock.calls[0]![0].where;
    expect(where).toMatchObject({ access: 'public', type: 'tile_layer' });
  });
});

describe('AuthedStacController', () => {
  const user = { id: 'u1', orgId: 'o1' } as unknown as AuthUser;

  function makeAuthed(rows: unknown[] = []) {
    const findMany = jest.fn().mockResolvedValue(rows);
    const findFirst = jest.fn().mockResolvedValue(null);
    const prisma = {
      item: { findMany, findFirst },
    } as unknown as PrismaService;
    const visibleWhere = jest
      .fn()
      .mockReturnValue({ marker: 'visible-where' });
    const sharing = { visibleWhere } as unknown as SharingService;
    return {
      ctrl: new AuthedStacController(prisma, sharing),
      findMany,
      findFirst,
      visibleWhere,
    };
  }

  it('lists through SharingService.visibleWhere, the one true predicate', async () => {
    const { ctrl, findMany, visibleWhere } = makeAuthed();
    await ctrl.collections(user, fakeReq());
    expect(visibleWhere).toHaveBeenCalledWith(user);
    const where = findMany.mock.calls[0]![0].where;
    expect(where.AND).toEqual([
      { type: 'tile_layer' },
      { marker: 'visible-where' },
    ]);
  });

  it('single-item reads re-apply visibleWhere in the WHERE', async () => {
    const { ctrl, findFirst, visibleWhere } = makeAuthed();
    await ctrl
      .item(
        user,
        fakeReq(),
        'rasters',
        '11111111-2222-4333-8444-555555555555',
      )
      .catch(() => undefined);
    expect(visibleWhere).toHaveBeenCalledWith(user);
    const where = findFirst.mock.calls[0]![0].where;
    expect(JSON.stringify(where)).toContain('visible-where');
  });

  it('mirrors the public surface conformance exactly', () => {
    const { ctrl } = makeAuthed();
    const { ctrl: pub } = makePublic();
    expect(ctrl.conformance()).toEqual(pub.conformance());
  });
});
