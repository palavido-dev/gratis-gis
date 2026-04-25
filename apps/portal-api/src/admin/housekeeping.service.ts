import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Heuristics-based analytics for the /admin/housekeeping page.
 * Three questions operators ask that the portal has enough data
 * to answer without any new tracking infrastructure:
 *
 *   1. Which items look abandoned? (no recent edits, no shares,
 *      no dependents)
 *   2. Which users haven't signed in for a long time? (lastSeenAt
 *      far in the past, or never)
 *   3. Which items are disproportionately large? (big data blobs
 *      or many attachments: the "your org's database is slow"
 *      suspects)
 *
 * All heuristics: not load-bearing for any automatic decision.
 * The admin makes the call on whether to act; this service just
 * surfaces the candidates. Thresholds are env-configurable with
 * reasonable defaults so operators can tune without a redeploy.
 */
@Injectable()
export class HousekeepingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: ConfigService,
  ) {}

  private get staleItemDays(): number {
    return this.resolvePositive('HOUSEKEEPING_STALE_ITEM_DAYS', 90);
  }

  private get staleUserDays(): number {
    return this.resolvePositive('HOUSEKEEPING_STALE_USER_DAYS', 180);
  }

  private get topN(): number {
    return this.resolvePositive('HOUSEKEEPING_TOP_N', 20);
  }

  private resolvePositive(key: string, fallback: number): number {
    const raw = Number(this.cfg.get<string>(key));
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
  }

  /**
   * Summary the admin page renders at the top: thresholds plus the
   * counts in each bucket, so the admin gets a sense of size before
   * scrolling into any individual list.
   */
  async summary(orgId: string) {
    const [stale, users, totalItems, totalUsers] = await Promise.all([
      this.countStaleItems(orgId),
      this.countStaleUsers(orgId),
      this.prisma.item.count({ where: { orgId, deletedAt: null } }),
      this.prisma.user.count({ where: { orgId } }),
    ]);
    return {
      staleItemDays: this.staleItemDays,
      staleUserDays: this.staleUserDays,
      staleItemCount: stale,
      staleUserCount: users,
      totalItemCount: totalItems,
      totalUserCount: totalUsers,
    };
  }

  /**
   * Items the admin might consider retiring. Heuristic: not
   * updated in `staleItemDays` AND has zero shares (nobody else
   * cares about this item). Dependency tracking in GratisGIS is
   * computed on the fly from `item.data` rather than stored in a
   * table, so we don't fold "is anyone depending on this" into
   * the query: the admin should glance at the item detail page
   * before deleting, where the dependents panel lives.
   */
  async staleItems(orgId: string) {
    const cutoff = new Date(
      Date.now() - this.staleItemDays * 24 * 60 * 60 * 1000,
    );
    const rows = await this.prisma.item.findMany({
      where: {
        orgId,
        deletedAt: null,
        updatedAt: { lt: cutoff },
        shares: { none: {} },
      },
      select: {
        id: true,
        title: true,
        type: true,
        updatedAt: true,
        ownerId: true,
        access: true,
        owner: { select: { username: true, fullName: true } },
      },
      orderBy: { updatedAt: 'asc' },
      take: this.topN,
    });
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      type: r.type,
      access: r.access,
      updatedAt: r.updatedAt.toISOString(),
      ownerId: r.ownerId,
      ownerLabel:
        r.owner?.fullName?.trim() ||
        r.owner?.username ||
        r.ownerId.slice(0, 8),
    }));
  }

  /**
   * Users who haven't been seen in a long time. Heuristic:
   * lastSeenAt older than `staleUserDays`, OR lastSeenAt is null
   * and createdAt older than `staleUserDays` (i.e. the seeded /
   * imported user who never signed in). We exclude admins: they
   * might be a break-glass account that legitimately sits idle.
   */
  async staleUsers(orgId: string) {
    const cutoff = new Date(
      Date.now() - this.staleUserDays * 24 * 60 * 60 * 1000,
    );
    const rows = await this.prisma.user.findMany({
      where: {
        orgId,
        orgRole: { not: 'admin' },
        OR: [
          { lastSeenAt: { lt: cutoff } },
          { AND: [{ lastSeenAt: null }, { createdAt: { lt: cutoff } }] },
        ],
      },
      select: {
        id: true,
        username: true,
        fullName: true,
        email: true,
        orgRole: true,
        createdAt: true,
        lastSeenAt: true,
        _count: { select: { ownedItems: true } },
      },
      orderBy: [{ lastSeenAt: 'asc' }, { createdAt: 'asc' }],
      take: this.topN,
    });
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      fullName: r.fullName,
      email: r.email,
      orgRole: r.orgRole,
      createdAt: r.createdAt.toISOString(),
      lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
      ownedItemCount: r._count.ownedItems,
    }));
  }

  /**
   * Top items by serialised data size. Using `octet_length` on
   * the JSONB column is a cheap way to approximate "how fat is
   * this item" without needing to count attachments separately.
   * For attachment-heavy items, PostGIS feature tables dominate
   * anyway; #65 follow-up can split that out.
   */
  async largeItems(orgId: string) {
    // pg_column_size accounts for compression; octet_length of the
    // JSON text is closer to "bytes the client saw". Close enough
    // for housekeeping: we just want a sortable proxy.
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        title: string;
        type: string;
        owner_id: string;
        owner_label: string | null;
        bytes: bigint;
        updated_at: Date;
      }>
    >`
      SELECT
        i.id,
        i.title,
        i.type,
        i.owner_id,
        COALESCE(NULLIF(u.full_name, ''), u.username) AS owner_label,
        octet_length(i.data_json::text) AS bytes,
        i.updated_at
      FROM "item" i
      LEFT JOIN "user" u ON u.id = i.owner_id
      WHERE i.org_id = ${orgId}::uuid
        AND i.deleted_at IS NULL
      ORDER BY bytes DESC
      LIMIT ${this.topN}
    `;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      type: r.type as string,
      ownerId: r.owner_id,
      ownerLabel: r.owner_label ?? r.owner_id.slice(0, 8),
      sizeBytes: Number(r.bytes),
      updatedAt: r.updated_at.toISOString(),
    }));
  }

  // ---------------------------------------------------------------
  // Count-only helpers used by summary(): skip the expensive
  // filter-in-memory step by joining on aggregate zero.
  // ---------------------------------------------------------------

  private async countStaleItems(orgId: string): Promise<number> {
    const cutoff = new Date(
      Date.now() - this.staleItemDays * 24 * 60 * 60 * 1000,
    );
    return this.prisma.item.count({
      where: {
        orgId,
        deletedAt: null,
        updatedAt: { lt: cutoff },
        shares: { none: {} },
      },
    });
  }

  private async countStaleUsers(orgId: string): Promise<number> {
    const cutoff = new Date(
      Date.now() - this.staleUserDays * 24 * 60 * 60 * 1000,
    );
    return this.prisma.user.count({
      where: {
        orgId,
        orgRole: { not: 'admin' },
        OR: [
          { lastSeenAt: { lt: cutoff } },
          { AND: [{ lastSeenAt: null }, { createdAt: { lt: cutoff } }] },
        ],
      },
    });
  }
}
