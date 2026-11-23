// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * The organization's time zone for expressions (today()). One
 * deployment serves one organization. Cached briefly so a tile
 * request does not read the organization row each time; a change in
 * the admin page shows within a minute.
 */
let cached: { value: string; at: number } | null = null;
const TTL_MS = 60_000;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function expressionTimeZone(prisma: PrismaService): Promise<string> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  const org = await prisma.organization.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { timeZone: true },
  });
  const tz = org?.timeZone && isValidTimeZone(org.timeZone) ? org.timeZone : 'UTC';
  cached = { value: tz, at: Date.now() };
  return tz;
}

/** Drop the cache after the admin changes the setting. */
export function clearExpressionTimeZoneCache(): void {
  cached = null;
}
