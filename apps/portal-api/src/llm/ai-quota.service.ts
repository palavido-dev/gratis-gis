// SPDX-License-Identifier: AGPL-3.0-or-later
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  orgDailyCallLimit,
  userDailyCallLimit,
  userMinuteCallLimit,
} from './ai-env.js';

/**
 * Org-wide usage bucket. Not a real user id; the FK only points at
 * organization. Chosen as a nil UUID so it can never collide with a
 * Keycloak sub.
 */
export const AI_ORG_USAGE_USER_ID = '00000000-0000-4000-8000-000000000000';

export function aiQuotaExceeded(
  message: string,
): HttpException {
  return new HttpException(
    {
      statusCode: 429,
      code: 'ai_quota_exceeded',
      error: 'Too Many Requests',
      message,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

export interface AiQuotaSnapshot {
  orgDailyLimit: number;
  orgDailyUsed: number;
  userDailyLimit: number;
  userDailyUsed: number;
  userMinuteLimit: number;
}

/**
 * Spend caps before every outbound model call. Daily counters live
 * in Postgres so both API replicas share them. The one-minute
 * window is in-process (same 2x ceiling as Nest's IP throttler).
 */
@Injectable()
export class AiQuotaService {
  /** userId -> recent call timestamps (ms). */
  private readonly minuteHits = new Map<string, number[]>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reserve one call against minute, user-day, and org-day caps.
   * Throws 429 `ai_quota_exceeded` when any cap would be exceeded.
   * Increments only when the call is allowed.
   */
  async consume(user: AuthUser): Promise<void> {
    this.consumeMinute(user.id);

    const userLimit = userDailyCallLimit();
    const orgLimit = orgDailyCallLimit();
    if (userLimit <= 0 && orgLimit <= 0) return;

    const day = utcDay();

    if (userLimit > 0) {
      const used = await this.bump(user.orgId, user.id, day);
      if (used > userLimit) {
        await this.decrement(user.orgId, user.id, day);
        throw aiQuotaExceeded(
          `Daily AI limit reached for this account (${userLimit} calls). Try again tomorrow.`,
        );
      }
    }

    if (orgLimit > 0) {
      const used = await this.bump(user.orgId, AI_ORG_USAGE_USER_ID, day);
      if (used > orgLimit) {
        await this.decrement(user.orgId, AI_ORG_USAGE_USER_ID, day);
        if (userLimit > 0) await this.decrement(user.orgId, user.id, day);
        throw aiQuotaExceeded(
          `Daily AI limit reached for this organization (${orgLimit} calls). Try again tomorrow.`,
        );
      }
    }
  }

  async snapshot(user: AuthUser): Promise<AiQuotaSnapshot> {
    const day = utcDay();
    const orgLimit = orgDailyCallLimit();
    const userLimit = userDailyCallLimit();
    const [orgRow, userRow] = await Promise.all([
      orgLimit > 0
        ? this.prisma.aiUsageDaily.findUnique({
            where: {
              orgId_userId_day: {
                orgId: user.orgId,
                userId: AI_ORG_USAGE_USER_ID,
                day,
              },
            },
          })
        : Promise.resolve(null),
      userLimit > 0
        ? this.prisma.aiUsageDaily.findUnique({
            where: {
              orgId_userId_day: {
                orgId: user.orgId,
                userId: user.id,
                day,
              },
            },
          })
        : Promise.resolve(null),
    ]);
    return {
      orgDailyLimit: orgLimit,
      orgDailyUsed: orgRow?.calls ?? 0,
      userDailyLimit: userLimit,
      userDailyUsed: userRow?.calls ?? 0,
      userMinuteLimit: userMinuteCallLimit(),
    };
  }

  /** Test helper: clear the in-process minute window. */
  _resetMinuteHitsForTests(): void {
    this.minuteHits.clear();
  }

  private consumeMinute(userId: string): void {
    const limit = userMinuteCallLimit();
    if (limit <= 0) return;
    const now = Date.now();
    const windowMs = 60_000;
    const prev = this.minuteHits.get(userId) ?? [];
    const recent = prev.filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      this.minuteHits.set(userId, recent);
      throw aiQuotaExceeded(
        `Too many AI requests. Wait a minute and try again (limit ${limit} per minute).`,
      );
    }
    recent.push(now);
    this.minuteHits.set(userId, recent);
  }

  private async bump(
    orgId: string,
    userId: string,
    day: Date,
  ): Promise<number> {
    const row = await this.prisma.aiUsageDaily.upsert({
      where: {
        orgId_userId_day: { orgId, userId, day },
      },
      create: { orgId, userId, day, calls: 1 },
      update: { calls: { increment: 1 } },
      select: { calls: true },
    });
    return row.calls;
  }

  private async decrement(
    orgId: string,
    userId: string,
    day: Date,
  ): Promise<void> {
    await this.prisma.aiUsageDaily.updateMany({
      where: { orgId, userId, day, calls: { gt: 0 } },
      data: { calls: { decrement: 1 } },
    });
  }
}

/** Midnight UTC for the current calendar day, as a Date for @db.Date. */
export function utcDay(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}
