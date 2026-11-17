// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The scrub read the expired list, purged each scope, then deleted
// the cache row by hash with no expiry check. A resolve that refreshed
// the row in between was left pointing at a half purged scope.

import { OsmScrubService } from './osm-scrub.service.js';

function service(claimCount: number, purge: () => Promise<number>) {
  const prisma = {
    osmQueryCache: {
      findMany: jest.fn(async () => [
        { hash: 'h1', scope: 'osm:h1', expiresAt: new Date(0) },
      ]),
      deleteMany: jest.fn(async () => ({ count: claimCount })),
      upsert: jest.fn(async () => ({})),
    },
  };
  const svc = new OsmScrubService(
    prisma as never,
    { shouldRun: () => true } as never,
    {} as never,
  );
  const purgeScope = jest.spyOn(svc, 'purgeScope').mockImplementation(purge);
  return { svc, prisma, purgeScope };
}

describe('OsmScrubService.scrubExpired', () => {
  it('claims the row only while it is still expired, then purges', async () => {
    const { svc, prisma, purgeScope } = service(1, async () => 5);
    await svc.scrubExpired();
    const where = (prisma.osmQueryCache.deleteMany.mock.calls[0] as unknown as [{ where: { hash: string; expiresAt: { lt: Date } } }])[0].where;
    expect(where.hash).toBe('h1');
    expect(where.expiresAt.lt).toBeInstanceOf(Date);
    expect(purgeScope).toHaveBeenCalledWith('osm:h1');
  });

  it('leaves a refreshed row and its scope alone', async () => {
    const { svc, purgeScope } = service(0, async () => 5);
    await svc.scrubExpired();
    expect(purgeScope).not.toHaveBeenCalled();
  });

  it('puts an expired row back when the purge fails, so it is retried', async () => {
    const { svc, prisma } = service(1, async () => {
      throw new Error('statement timeout');
    });
    await svc.scrubExpired();
    expect(prisma.osmQueryCache.upsert).toHaveBeenCalledTimes(1);
  });
});
