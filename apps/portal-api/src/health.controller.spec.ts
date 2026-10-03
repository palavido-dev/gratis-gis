// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Response } from 'express';

import { HealthController } from './health.controller';
import type { PrismaService } from './prisma/prisma.service';

function response(): Response {
  return { status: jest.fn().mockReturnThis() } as unknown as Response;
}

describe('HealthController', () => {
  it('reports ok when the database answers', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    } as unknown as PrismaService;
    const res = response();
    const body = await new HealthController(prisma).check(res);
    expect(body.status).toBe('ok');
    expect(body.checks.database).toBe('ok');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 503 when the database does not answer', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockRejectedValue(new Error('connection refused')),
    } as unknown as PrismaService;
    const res = response();
    const body = await new HealthController(prisma).check(res);
    expect(body.status).toBe('degraded');
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
