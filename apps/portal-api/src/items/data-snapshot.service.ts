import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Versioning for an Item's data blob. Callers take a snapshot
 * before every replace (PATCH that changes `data`, bulk-import,
 * file upload) so an admin can revert to a known-good prior state
 * without needing infrastructure-level backups.
 *
 * Retention has two gates, whichever kicks in first:
 *   - TTL: 30 days since createdAt (configurable via env
 *     ITEM_SNAPSHOT_TTL_DAYS)
 *   - Cap: keep at most 20 snapshots per item (configurable via
 *     ITEM_SNAPSHOT_CAP_PER_ITEM)
 *
 * The purge pass runs on a schedule in MaintenanceModule.
 */
@Injectable()
export class DataSnapshotService {
  constructor(private readonly prisma: PrismaService) {}

  private get ttlDays(): number {
    const raw = Number(process.env.ITEM_SNAPSHOT_TTL_DAYS);
    return Number.isFinite(raw) && raw > 0 ? raw : 30;
  }

  private get capPerItem(): number {
    const raw = Number(process.env.ITEM_SNAPSHOT_CAP_PER_ITEM);
    return Number.isFinite(raw) && raw > 0 ? raw : 20;
  }

  /**
   * Snapshot the current `data` of an item. Called RIGHT BEFORE a
   * replace so the snapshot captures what was there. If the item
   * doesn't exist yet (first-time write) the snapshot is skipped;
   * the caller is expected to pass the same itemId they're about
   * to mutate.
   */
  async snapshot(itemId: string, userId: string, note?: string) {
    const existing = await this.prisma.item.findUnique({
      where: { id: itemId },
      select: { data: true },
    });
    if (!existing) return null;
    const created = await this.prisma.itemDataSnapshot.create({
      data: {
        itemId,
        data: existing.data as Prisma.InputJsonValue,
        createdBy: userId,
        ...(note ? { note } : {}),
      },
    });
    // Enforce the per-item cap synchronously: if we just pushed the
    // 21st snapshot, the 1st drops off now. Cheaper than a periodic
    // sweep because we already know which item we touched.
    await this.enforceCap(itemId);
    return created;
  }

  /**
   * List snapshots for an item, newest first. Returns a lean
   * projection (without the full data blob) so the history panel
   * can render a timeline without downloading megabytes per
   * snapshot.
   */
  list(itemId: string) {
    return this.prisma.itemDataSnapshot.findMany({
      where: { itemId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        itemId: true,
        note: true,
        createdAt: true,
        createdBy: true,
      },
    });
  }

  /** Fetch a single snapshot including the full data blob. */
  async get(snapshotId: string) {
    const snap = await this.prisma.itemDataSnapshot.findUnique({
      where: { id: snapshotId },
    });
    if (!snap) throw new NotFoundException('Snapshot not found');
    return snap;
  }

  /**
   * Restore an item's data from a snapshot. Captures the CURRENT
   * data as a fresh snapshot before the revert, so 'undo revert'
   * is also possible within the retention window.
   */
  async revert(snapshotId: string, userId: string) {
    const snap = await this.get(snapshotId);
    // Snapshot-before-revert so the user can un-revert. Note = a
    // breadcrumb pointing back at the target snapshot id, for
    // auditability.
    await this.snapshot(
      snap.itemId,
      userId,
      `pre-revert to snapshot ${snap.id}`,
    );
    await this.prisma.item.update({
      where: { id: snap.itemId },
      data: { data: snap.data as Prisma.InputJsonValue },
    });
    return { itemId: snap.itemId, revertedFrom: snap.id };
  }

  /** Drop snapshots older than TTL or beyond the per-item cap. */
  async purge(): Promise<{ removedByAge: number; removedByCap: number }> {
    const ttlCutoff = new Date(
      Date.now() - this.ttlDays * 24 * 60 * 60 * 1000,
    );
    const ageRes = await this.prisma.itemDataSnapshot.deleteMany({
      where: { createdAt: { lt: ttlCutoff } },
    });

    // Cap enforcement: for each item with > cap snapshots, drop the
    // oldest. Done in one round-trip via a subquery so we don't
    // fetch everything into Node.
    const rows = await this.prisma.$queryRaw<Array<{ item_id: string }>>`
      SELECT "item_id"
      FROM "item_data_snapshot"
      GROUP BY "item_id"
      HAVING COUNT(*) > ${this.capPerItem}
    `;
    let removedByCap = 0;
    for (const row of rows) {
      removedByCap += await this.enforceCap(row.item_id);
    }
    return { removedByAge: ageRes.count, removedByCap };
  }

  /**
   * Drop snapshots beyond the per-item cap for a single item.
   * Always called synchronously after a new snapshot is written so
   * the cap is enforced at write time and not just by the cron.
   */
  private async enforceCap(itemId: string): Promise<number> {
    const cap = this.capPerItem;
    const extras = await this.prisma.itemDataSnapshot.findMany({
      where: { itemId },
      orderBy: { createdAt: 'desc' },
      skip: cap,
      select: { id: true },
    });
    if (extras.length === 0) return 0;
    const res = await this.prisma.itemDataSnapshot.deleteMany({
      where: { id: { in: extras.map((e) => e.id) } },
    });
    return res.count;
  }
}
