// SPDX-License-Identifier: AGPL-3.0-or-later
import { Logger } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { LastUsageStamp } from './last-usage-stamp';

/**
 * These tests exist because the bug they pin was invisible to every
 * other check. `prisma.item.update({ data: { lastUsageAt } })`
 * type-checks, passes lint, and does exactly the wrong thing: Prisma's
 * `@updatedAt` on the Item model rewrites `updated_at` on any update
 * through the client, so a passive read advanced the item's "Updated"
 * timestamp. Nothing failed. It shipped.
 *
 * The assertion that matters is the negative one: `item.update` is
 * never called. Do not relax it.
 */
describe('LastUsageStamp', () => {
  function makePrisma(): {
    prisma: PrismaService;
    executeRaw: jest.Mock;
    itemUpdate: jest.Mock;
  } {
    const executeRaw = jest.fn().mockResolvedValue(1);
    const itemUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      $executeRaw: executeRaw,
      item: { update: itemUpdate },
    } as unknown as PrismaService;
    return { prisma, executeRaw, itemUpdate };
  }

  const silentLog = {
    warn: jest.fn(),
  } as unknown as Logger;

  beforeEach(() => jest.clearAllMocks());

  it('writes last_usage_at without going through prisma.item.update', () => {
    const { prisma, executeRaw, itemUpdate } = makePrisma();
    const stamp = new LastUsageStamp(prisma, silentLog, 60_000);

    stamp.stamp('11111111-1111-1111-1111-111111111111');

    expect(executeRaw).toHaveBeenCalledTimes(1);
    // The whole point. A Prisma client update would carry @updatedAt.
    expect(itemUpdate).not.toHaveBeenCalled();
  });

  it('targets last_usage_at and never names updated_at', () => {
    const { prisma, executeRaw } = makePrisma();
    const stamp = new LastUsageStamp(prisma, silentLog, 60_000);

    stamp.stamp('22222222-2222-2222-2222-222222222222');

    // Tagged-template call: first arg is the string fragments array.
    const fragments = (executeRaw.mock.calls[0]?.[0] ?? []) as string[];
    const sql = Array.from(fragments).join('?');
    expect(sql).toContain('last_usage_at');
    expect(sql).not.toContain('updated_at');
  });

  it('throttles repeat stamps of the same item inside the window', () => {
    const { prisma, executeRaw } = makePrisma();
    const stamp = new LastUsageStamp(prisma, silentLog, 60_000);
    const id = '33333333-3333-3333-3333-333333333333';
    const t0 = 1_700_000_000_000;

    stamp.stamp(id, t0);
    stamp.stamp(id, t0 + 1_000);
    stamp.stamp(id, t0 + 59_999);

    expect(executeRaw).toHaveBeenCalledTimes(1);

    stamp.stamp(id, t0 + 60_000);
    expect(executeRaw).toHaveBeenCalledTimes(2);
  });

  it('throttles per item, not globally', () => {
    const { prisma, executeRaw } = makePrisma();
    const stamp = new LastUsageStamp(prisma, silentLog, 60_000);
    const t0 = 1_700_000_000_000;

    stamp.stamp('44444444-4444-4444-4444-444444444444', t0);
    stamp.stamp('55555555-5555-5555-5555-555555555555', t0);

    expect(executeRaw).toHaveBeenCalledTimes(2);
  });

  it('rolls the throttle back when the write fails, so the next read retries', async () => {
    const executeRaw = jest.fn().mockRejectedValue(new Error('db down'));
    const prisma = {
      $executeRaw: executeRaw,
      item: { update: jest.fn() },
    } as unknown as PrismaService;
    const stamp = new LastUsageStamp(prisma, silentLog, 60_000);
    const id = '66666666-6666-6666-6666-666666666666';
    const t0 = 1_700_000_000_000;

    stamp.stamp(id, t0);
    // Let the rejection settle so the catch clears the throttle entry.
    await Promise.resolve();
    await Promise.resolve();

    stamp.stamp(id, t0 + 1_000);
    expect(executeRaw).toHaveBeenCalledTimes(2);
  });

  it('does not reject when the write fails', () => {
    const executeRaw = jest.fn().mockRejectedValue(new Error('db down'));
    const prisma = {
      $executeRaw: executeRaw,
      item: { update: jest.fn() },
    } as unknown as PrismaService;
    const stamp = new LastUsageStamp(prisma, silentLog, 60_000);

    // Fire-and-forget: a failed stamp must not surface to the request.
    expect(() =>
      stamp.stamp('77777777-7777-7777-7777-777777777777'),
    ).not.toThrow();
  });
});
