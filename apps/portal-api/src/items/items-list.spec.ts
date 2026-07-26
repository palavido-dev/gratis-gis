// SPDX-License-Identifier: AGPL-3.0-or-later
import { ConflictException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { SharingService } from './sharing.service.js';
import { ItemsService } from './items.service.js';
import { ItemsController } from './items.controller.js';

/**
 * Unit tests for the items list paging + narrow-by-default contract
 * and the opt-in expectedUpdatedAt precondition on PATCH.
 *
 * What is pinned down here and why:
 *   - The list must never ship data_json unless the caller passes
 *     ?full=1: this is the regression the fix exists for (unbounded
 *     multi-MB list responses).
 *   - The ?limit= hard cap must hold: without it a caller can opt
 *     back into an unbounded response.
 *   - X-Total-Count must be computed off the SAME filter set as the
 *     rows, otherwise pagers stop honestly.
 *   - PATCH with a stale expectedUpdatedAt must 409 rather than
 *     silently overwrite a concurrent save (folder editors do
 *     read-modify-write on childItemIds).
 */

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    orgId: 'org-1',
    orgSlug: 'org-1',
    username: 'alice',
    email: 'alice@example.com',
    orgRole: 'contributor',
    groupIds: [],
    capabilities: new Set(),
    ...overrides,
  } as AuthUser;
}

interface FakePrisma {
  item: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    count: jest.Mock;
    update: jest.Mock;
  };
  itemShare: { findMany: jest.Mock };
  $queryRaw: jest.Mock;
}

function makePrisma(): FakePrisma {
  return {
    item: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn(),
    },
    itemShare: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
}

function makeService(prisma: FakePrisma): ItemsService {
  const sharing = new SharingService(prisma as never, new PolicyService());
  // The list + update paths under test never touch the table
  // reconciler, snapshots, notifications, derived layers, or
  // storage; inert stubs keep the constructor honest without
  // dragging their dependency trees into a unit test.
  return new ItemsService(
    prisma as never,
    sharing,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

/** Controller with everything stubbed except the ItemsService seam. */
function makeController(items: Partial<ItemsService>): {
  controller: ItemsController;
  res: { setHeader: jest.Mock };
} {
  const controller = new ItemsController(
    items as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { controller, res: { setHeader: jest.fn() } };
}

function makeListRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    orgId: 'org-1',
    ownerId: 'user-1',
    type: 'map',
    title: 'A map',
    description: '',
    tags: [],
    thumbnailUrl: null,
    thumbnailDesign: null,
    license: null,
    storageRef: null,
    access: 'org',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    deletedAt: null,
    bbox: [],
    bboxSrs: 'EPSG:4326',
    shares: [],
    owner: {
      id: 'user-1',
      username: 'alice',
      fullName: 'Alice',
      avatarUrl: null,
    },
    ...overrides,
  };
}

describe('ItemsService list paging and projection', () => {
  it('lite mode selects rows WITHOUT the data payload', async () => {
    const prisma = makePrisma();
    prisma.item.findMany.mockResolvedValue([makeListRow()]);
    const svc = makeService(prisma);

    const rows = (await svc.list(makeUser(), { lite: true })) as Array<
      Record<string, unknown>
    >;

    expect(prisma.item.findMany).toHaveBeenCalledTimes(1);
    const args = prisma.item.findMany.mock.calls[0]![0] as {
      select: Record<string, unknown>;
    };
    // The projection itself must not ask Postgres for data_json;
    // stripping after the fact would still pay the transfer cost.
    expect(args.select).not.toHaveProperty('data');
    expect(rows[0]).not.toHaveProperty('data');
  });

  it('full mode selects rows WITH the data payload', async () => {
    const prisma = makePrisma();
    prisma.item.findMany.mockResolvedValue([
      makeListRow({ data: { hello: 1 } }),
    ]);
    const svc = makeService(prisma);

    const rows = (await svc.list(makeUser(), { lite: false })) as Array<
      Record<string, unknown>
    >;

    const args = prisma.item.findMany.mock.calls[0]![0] as {
      select: Record<string, unknown>;
    };
    expect(args.select).toHaveProperty('data', true);
    expect(rows[0]).toHaveProperty('data', { hello: 1 });
  });

  it('passes take/skip through to Prisma when limit/offset are set', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);

    await svc.list(makeUser(), { lite: true, limit: 500, offset: 1000 });

    const args = prisma.item.findMany.mock.calls[0]![0] as {
      take?: number;
      skip?: number;
    };
    expect(args.take).toBe(500);
    expect(args.skip).toBe(1000);
  });

  it('omits take/skip entirely for internal unbounded callers', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);

    await svc.list(makeUser(), { lite: true });

    const args = prisma.item.findMany.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect('take' in args).toBe(false);
    expect('skip' in args).toBe(false);
  });

  it('listPaged counts with the same where as the page query (type filter included)', async () => {
    const prisma = makePrisma();
    prisma.item.findMany.mockResolvedValue([makeListRow()]);
    prisma.item.count.mockResolvedValue(42);
    const svc = makeService(prisma);

    const { rows, total } = await svc.listPaged(makeUser(), {
      lite: true,
      type: 'map',
      limit: 10,
    });

    expect(total).toBe(42);
    expect(Array.isArray(rows)).toBe(true);
    const findWhere = (
      prisma.item.findMany.mock.calls[0]![0] as { where: unknown }
    ).where;
    const countWhere = (
      prisma.item.count.mock.calls[0]![0] as { where: unknown }
    ).where;
    // Same object, not merely similar: both sides were built once so
    // the header can never drift from the rows under a type filter.
    expect(countWhere).toBe(findWhere);
    expect(countWhere).toMatchObject({ type: 'map' });
  });

  it('annotates web_app rows with _template in lite mode', async () => {
    const prisma = makePrisma();
    const webAppId = '22222222-2222-2222-2222-222222222222';
    prisma.item.findMany.mockResolvedValue([
      makeListRow({ id: webAppId, type: 'web_app' }),
    ]);
    prisma.$queryRaw.mockResolvedValue([
      {
        id: webAppId,
        template: 'viewer',
        has_targets: true,
        has_snapping: false,
        has_tools: true,
      },
    ]);
    const svc = makeService(prisma);

    const rows = (await svc.list(makeUser(), { lite: true })) as Array<
      Record<string, unknown>
    >;

    expect(rows[0]).toMatchObject({ _template: 'viewer' });
    expect(rows[0]).not.toHaveProperty('data');
  });
});

describe('ItemsController GET /items paging contract', () => {
  it('defaults to lite + limit 500 and emits X-Total-Count', async () => {
    const listPaged = jest
      .fn()
      .mockResolvedValue({ rows: [{ id: 'x' }], total: 7 });
    const { controller, res } = makeController({ listPaged });

    const body = await controller.list(makeUser(), res as never);

    expect(body).toEqual([{ id: 'x' }]);
    expect(res.setHeader).toHaveBeenCalledWith('X-Total-Count', '7');
    const opts = listPaged.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts.lite).toBe(true);
    expect(opts.limit).toBe(500);
    expect('offset' in opts).toBe(false);
  });

  it('full=1 restores the data payload (lite: false)', async () => {
    const listPaged = jest.fn().mockResolvedValue({ rows: [], total: 0 });
    const { controller, res } = makeController({ listPaged });

    await controller.list(
      makeUser(),
      res as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '1',
    );

    const opts = listPaged.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts.lite).toBe(false);
  });

  it('an explicit lite=1 wins even when combined with full=1', async () => {
    const listPaged = jest.fn().mockResolvedValue({ rows: [], total: 0 });
    const { controller, res } = makeController({ listPaged });

    await controller.list(
      makeUser(),
      res as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '1',
      '1',
    );

    const opts = listPaged.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts.lite).toBe(true);
  });

  it('enforces the hard cap of 1000 on ?limit=', async () => {
    const listPaged = jest.fn().mockResolvedValue({ rows: [], total: 0 });
    const { controller, res } = makeController({ listPaged });

    await controller.list(
      makeUser(),
      res as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '999999',
      '25',
    );

    const opts = listPaged.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts.limit).toBe(1000);
    expect(opts.offset).toBe(25);
  });

  it('falls back to the default limit on malformed ?limit=', async () => {
    const listPaged = jest.fn().mockResolvedValue({ rows: [], total: 0 });
    const { controller, res } = makeController({ listPaged });

    await controller.list(
      makeUser(),
      res as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'banana',
      '-3',
    );

    const opts = listPaged.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts.limit).toBe(500);
    expect('offset' in opts).toBe(false);
  });

  it('emits X-Total-Count from the filtered total when ?type= is set', async () => {
    const listPaged = jest
      .fn()
      .mockResolvedValue({ rows: [{ id: 'a' }, { id: 'b' }], total: 231 });
    const { controller, res } = makeController({ listPaged });

    const body = await controller.list(
      makeUser(),
      res as never,
      undefined,
      'basemap',
    );

    expect((body as unknown[]).length).toBe(2);
    expect(res.setHeader).toHaveBeenCalledWith('X-Total-Count', '231');
    const opts = listPaged.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts.type).toBe('basemap');
  });
});

describe('PublicController GET /public/items mirror', () => {
  // Imported lazily so the spec file's top stays items-focused; the
  // public controller only needs prisma for this route.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PublicController } = require('../public/public.controller.js') as {
    PublicController: new (
      prisma: unknown,
      v3: unknown,
    ) => {
      items: (
        res: unknown,
        type?: string,
        full?: string,
        limit?: string,
        offset?: string,
      ) => Promise<unknown[]>;
    };
  };

  function makePublic(prisma: FakePrisma) {
    const controller = new PublicController(prisma as never, {} as never);
    return { controller, res: { setHeader: jest.fn() } };
  }

  it('strips data by default and pages with the same 500/1000 bounds', async () => {
    const prisma = makePrisma();
    prisma.item.findMany.mockResolvedValue([{ id: 'b1' }]);
    prisma.item.count.mockResolvedValue(3);
    const { controller, res } = makePublic(prisma);

    const body = await controller.items(res as never, 'basemap');

    expect(body).toEqual([{ id: 'b1' }]);
    expect(res.setHeader).toHaveBeenCalledWith('X-Total-Count', '3');
    const args = prisma.item.findMany.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(args.omit).toEqual({ data: true });
    expect(args.take).toBe(500);
  });

  it('full=1 restores data and the limit cap still holds', async () => {
    const prisma = makePrisma();
    prisma.item.findMany.mockResolvedValue([]);
    prisma.item.count.mockResolvedValue(0);
    const { controller, res } = makePublic(prisma);

    await controller.items(res as never, 'basemap', '1', '4000', '10');

    const args = prisma.item.findMany.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect('omit' in args).toBe(false);
    expect(args.take).toBe(1000);
    expect(args.skip).toBe(10);
  });

  it('keeps refusing non-basemap types, with an honest zero total', async () => {
    const prisma = makePrisma();
    const { controller, res } = makePublic(prisma);

    const body = await controller.items(res as never, 'data_layer');

    expect(body).toEqual([]);
    expect(prisma.item.findMany).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('X-Total-Count', '0');
  });
});

describe('ItemsService update expectedUpdatedAt precondition', () => {
  const ROW_UPDATED_AT = new Date('2026-07-01T12:00:00.000Z');

  function primeUpdate(prisma: FakePrisma) {
    const row = makeListRow({
      type: 'basemap',
      updatedAt: ROW_UPDATED_AT,
      data: { version: 1, kind: 'tile-url', tileUrl: 'https://x/{z}/{x}/{y}.png' },
    });
    prisma.item.findUnique.mockResolvedValue(row);
    prisma.item.update.mockResolvedValue({ ...row, title: 'Renamed' });
  }

  it('409s when the supplied expectedUpdatedAt is stale', async () => {
    const prisma = makePrisma();
    primeUpdate(prisma);
    const svc = makeService(prisma);

    await expect(
      svc.update(makeUser(), 'item-1', {
        title: 'Renamed',
        expectedUpdatedAt: '2026-06-30T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.item.update).not.toHaveBeenCalled();
  });

  it('applies the update when expectedUpdatedAt matches exactly', async () => {
    const prisma = makePrisma();
    primeUpdate(prisma);
    const svc = makeService(prisma);

    const out = await svc.update(makeUser(), 'item-1', {
      title: 'Renamed',
      expectedUpdatedAt: ROW_UPDATED_AT.toISOString(),
    });

    expect(prisma.item.update).toHaveBeenCalledTimes(1);
    // The precondition field is transport-only; it must never reach
    // the Prisma update payload.
    const updateArgs = prisma.item.update.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(updateArgs.data).not.toHaveProperty('expectedUpdatedAt');
    expect(out).toMatchObject({ title: 'Renamed' });
  });

  it('stays last-write-wins when the field is omitted (opt-in contract)', async () => {
    const prisma = makePrisma();
    primeUpdate(prisma);
    const svc = makeService(prisma);

    await svc.update(makeUser(), 'item-1', { title: 'Renamed' });

    expect(prisma.item.update).toHaveBeenCalledTimes(1);
  });
});

// v0.9.1 regression: the trash list must serialize the lean owner
// projection. The pre-snapshot demo purge keys keep-or-purge on
// owner.username and hard-aborts when it is missing, which is exactly
// what happened on the first v0.9.0 golden refresh.
describe('listTrash owner projection', () => {
  it('includes the lean owner select', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    await svc.listTrash({ id: 'u1', orgId: 'o1', orgRole: 'admin' } as never);
    const arg = prisma.item.findMany.mock.calls[0][0];
    expect(arg.include.owner.select).toEqual({
      id: true,
      username: true,
      fullName: true,
      avatarUrl: true,
    });
  });
});
