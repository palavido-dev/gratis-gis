// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Heavy analysis kinds share one queue with every org. One user, or
// one org, may only have a few jobs waiting or running at once.

import { HttpException } from '@nestjs/common';

import {
  ANALYSIS_MAX_IN_FLIGHT_PER_ORG,
  ANALYSIS_MAX_IN_FLIGHT_PER_USER,
  AnalysisService,
} from './analysis.service.js';

function service(mine: number, org: number) {
  const count = jest.fn(async ({ where }: { where: { userId?: string } }) =>
    where.userId ? mine : org,
  );
  const svc = new AnalysisService(
    { analysisJob: { count } } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const check = () =>
    (svc as unknown as { assertJobCapacity(u: unknown): Promise<void> }).assertJobCapacity({
      id: 'u',
      orgId: 'o',
    });
  return { check, count };
}

describe('analysis job capacity', () => {
  it('allows a user under both caps', async () => {
    await expect(service(0, 0).check()).resolves.toBeUndefined();
  });

  it('refuses a user at the per-user cap with 429', async () => {
    const err = await service(ANALYSIS_MAX_IN_FLIGHT_PER_USER, 0).check().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
  });

  it('refuses when the org is at its cap', async () => {
    await expect(service(0, ANALYSIS_MAX_IN_FLIGHT_PER_ORG).check()).rejects.toBeInstanceOf(HttpException);
  });

  it('does not count outline embeddings, which have their own cap', async () => {
    const { check, count } = service(0, 0);
    await check();
    for (const call of count.mock.calls) {
      expect((call[0] as { where: { kind: unknown } }).where.kind).toEqual({ not: 'sam-embed' });
    }
  });
});
