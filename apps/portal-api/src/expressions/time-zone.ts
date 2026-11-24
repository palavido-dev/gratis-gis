// SPDX-License-Identifier: AGPL-3.0-or-later
import { isMultiTenant } from '../common/tenancy.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * The organization's time zone for expressions (today()). Cached
 * briefly so a tile request does not read the organization row each
 * time; a change in the admin page shows within a minute.
 *
 * Which organization:
 * - single mode: the install's organization (the oldest one), as
 *   before. The org id passed in is not used.
 * - multi mode: the org id passed in, which is the org that owns the
 *   item whose expression runs (not the viewer's), so a public map
 *   viewed anonymously still uses its owner's time zone. No org id
 *   reads as UTC, never as another org's zone.
 */
const TTL_MS = 60_000;
/** Cache key for the single-mode install value. */
const INSTALL_KEY = '';
/** Enough for every org on a large install; cleared when passed. */
const MAX_ENTRIES = 10_000;
const cache = new Map<string, { value: string; at: number }>();

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param orgId The org that owns the item being evaluated. `null`
 *   only where no org is known (an anonymous portal-info request);
 *   in multi mode that reads as UTC.
 */
export async function expressionTimeZone(
  prisma: PrismaService,
  orgId: string | null,
): Promise<string> {
  const multi = isMultiTenant();
  if (multi && !orgId) return 'UTC';
  const key = multi ? (orgId as string) : INSTALL_KEY;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let org: { timeZone: string | null } | null = null;
  try {
    // A test double without an organization table reads as UTC.
    org = multi
      ? ((await prisma.organization?.findUnique({
          where: { id: orgId as string },
          select: { timeZone: true },
        })) ?? null)
      : ((await prisma.organization?.findFirst({
          orderBy: { createdAt: 'asc' },
          select: { timeZone: true },
        })) ?? null);
  } catch {
    org = null;
  }
  const tz = org?.timeZone && isValidTimeZone(org.timeZone) ? org.timeZone : 'UTC';
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(key, { value: tz, at: Date.now() });
  return tz;
}

/** Drop the cached zone of one org after its admin changes it. */
export function clearExpressionTimeZoneCache(orgId: string): void {
  cache.delete(isMultiTenant() ? orgId : INSTALL_KEY);
}

/** Tests only: forget every cached zone. */
export function resetExpressionTimeZoneCacheForTests(): void {
  cache.clear();
}
