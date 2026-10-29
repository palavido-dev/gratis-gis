// SPDX-License-Identifier: AGPL-3.0-or-later
import { HttpException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  AI_ORG_USAGE_USER_ID,
  AiQuotaService,
  utcDay,
} from './ai-quota.service.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

function authUser(): AuthUser {
  return {
    id: USER,
    orgId: ORG,
    orgSlug: 'demo',
    username: 'tester',
    email: 'tester@example.com',
    orgRole: 'contributor',
    groupIds: [],
    capabilities: new Set(),
  };
}

describe('AiQuotaService', () => {
  const keys = [
    'PORTAL_LOCK_ADMIN_TIER',
    'PORTAL_AI_ORG_DAILY_CALL_LIMIT',
    'PORTAL_AI_USER_DAILY_CALL_LIMIT',
    'PORTAL_AI_USER_MINUTE_CALL_LIMIT',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of keys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function setup(initial: Map<string, number> = new Map()) {
    const rows = new Map(initial);
    const keyOf = (orgId: string, userId: string, day: Date) =>
      `${orgId}|${userId}|${day.toISOString().slice(0, 10)}`;

    const prisma = {
      aiUsageDaily: {
        upsert: jest.fn(
          async ({
            where,
            create,
            update,
          }: {
            where: {
              orgId_userId_day: { orgId: string; userId: string; day: Date };
            };
            create: { calls: number };
            update: { calls: { increment: number } };
          }) => {
            const w = where.orgId_userId_day;
            const k = keyOf(w.orgId, w.userId, w.day);
            const next =
              (rows.get(k) ?? 0) +
              (rows.has(k) ? update.calls.increment : create.calls);
            rows.set(k, next);
            return { calls: next };
          },
        ),
        updateMany: jest.fn(
          async ({
            where,
            data,
          }: {
            where: {
              orgId: string;
              userId: string;
              day: Date;
              calls: { gt: number };
            };
            data: { calls: { decrement: number } };
          }) => {
            const k = keyOf(where.orgId, where.userId, where.day);
            const cur = rows.get(k) ?? 0;
            if (cur > where.calls.gt) {
              rows.set(k, Math.max(0, cur - data.calls.decrement));
              return { count: 1 };
            }
            return { count: 0 };
          },
        ),
        findUnique: jest.fn(
          async ({
            where,
          }: {
            where: {
              orgId_userId_day: { orgId: string; userId: string; day: Date };
            };
          }) => {
            const w = where.orgId_userId_day;
            const k = keyOf(w.orgId, w.userId, w.day);
            const calls = rows.get(k);
            return calls === undefined ? null : { calls };
          },
        ),
      },
    };

    const service = new AiQuotaService(prisma as unknown as PrismaService);
    return { service, rows, keyOf, prisma };
  }

  it('allows calls when no daily caps are set', async () => {
    process.env.PORTAL_AI_USER_MINUTE_CALL_LIMIT = '100';
    const { service, prisma } = setup();
    await service.consume(authUser());
    expect(prisma.aiUsageDaily.upsert).not.toHaveBeenCalled();
  });

  it('refuses after the per-user daily cap', async () => {
    process.env.PORTAL_AI_USER_DAILY_CALL_LIMIT = '2';
    process.env.PORTAL_AI_ORG_DAILY_CALL_LIMIT = '0';
    process.env.PORTAL_AI_USER_MINUTE_CALL_LIMIT = '100';
    const { service } = setup();
    await service.consume(authUser());
    await service.consume(authUser());
    await expect(service.consume(authUser())).rejects.toBeInstanceOf(
      HttpException,
    );
    try {
      await service.consume(authUser());
    } catch (err) {
      const body = (err as HttpException).getResponse() as { code?: string };
      expect(body.code).toBe('ai_quota_exceeded');
    }
  });

  it('refuses after the org daily cap and rolls back the user bump', async () => {
    process.env.PORTAL_AI_USER_DAILY_CALL_LIMIT = '50';
    process.env.PORTAL_AI_ORG_DAILY_CALL_LIMIT = '1';
    process.env.PORTAL_AI_USER_MINUTE_CALL_LIMIT = '100';
    const day = utcDay();
    const orgKey = `${ORG}|${AI_ORG_USAGE_USER_ID}|${day.toISOString().slice(0, 10)}`;
    const userKey = `${ORG}|${USER}|${day.toISOString().slice(0, 10)}`;
    const { service, rows } = setup(new Map([[orgKey, 1]]));
    await expect(service.consume(authUser())).rejects.toMatchObject({
      status: 429,
    });
    expect(rows.get(userKey) ?? 0).toBe(0);
    expect(rows.get(orgKey)).toBe(1);
  });

  it('refuses when the per-minute window is full', async () => {
    process.env.PORTAL_AI_USER_MINUTE_CALL_LIMIT = '2';
    process.env.PORTAL_AI_USER_DAILY_CALL_LIMIT = '0';
    process.env.PORTAL_AI_ORG_DAILY_CALL_LIMIT = '0';
    const { service } = setup();
    await service.consume(authUser());
    await service.consume(authUser());
    await expect(service.consume(authUser())).rejects.toMatchObject({
      status: 429,
    });
  });
});
