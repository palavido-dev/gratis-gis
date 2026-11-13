// SPDX-License-Identifier: AGPL-3.0-or-later
import { PublicController } from './public.controller.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Review 27-12: an anonymous viewer of a public app got the stock
 * starter colours because the public list served basemaps only. It
 * now serves public theme rows too, scoped to the app's org.
 */
describe('PublicController.items theme rows', () => {
  const ORG = '11111111-1111-4111-8111-111111111111';

  function setup() {
    const findMany = jest.fn(async (_args: unknown) => [{ id: 't1' }]);
    const count = jest.fn(async (_args: unknown) => 1);
    const prisma = { item: { findMany, count } };
    const controller = new PublicController(
      prisma as unknown as PrismaService,
      {} as never,
      {} as never,
    );
    const res = { setHeader: jest.fn() };
    return { controller, findMany, count, res };
  }

  it('serves public themes of the given org', async () => {
    const { controller, findMany, res } = setup();
    const out = await controller.items(
      res as never,
      'theme',
      '1',
      undefined,
      undefined,
      ORG,
    );
    expect(out).toEqual([{ id: 't1' }]);
    const args = findMany.mock.calls[0]![0] as { where: unknown };
    expect(args.where).toEqual({
      type: 'theme',
      access: 'public',
      deletedAt: null,
      orgId: ORG,
    });
  });

  it('ignores a malformed orgId and still refuses other types', async () => {
    const { controller, findMany, res } = setup();
    await controller.items(res as never, 'theme', undefined, undefined, undefined, 'x');
    const args = findMany.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(args.where.orgId).toBeUndefined();
    expect(args.where.access).toBe('public');

    const other = await controller.items(res as never, 'map');
    expect(other).toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
