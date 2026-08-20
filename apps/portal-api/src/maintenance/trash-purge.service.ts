// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import type { ItemType } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import { LeaderElectionService } from '../cron/leader-election.service.js';
import { ItemsService } from '../items/items.service.js';

/**
 * Permanently deletes rows from the trash once their retention window
 * has elapsed. Runs nightly; see docs/soft-delete.md for the user-
 * visible contract.
 *
 * Why a scheduled job rather than a per-request check:
 *   - Purge is a destructive operation we want audited in one place, not
 *     scattered through item/group code paths.
 *   - A nightly sweep cleanly handles "day 30" boundaries without
 *     depending on whoever happens to hit the site first that morning.
 *
 * The retention window is configurable via RECYCLE_BIN_RETENTION_DAYS;
 * default 30 matches every user-facing surface.
 */
@Injectable()
export class TrashPurgeService {
  private readonly log = new Logger(TrashPurgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: ConfigService,
    private readonly leader: LeaderElectionService,
    private readonly items: ItemsService,
  ) {}

  // 3am UTC keeps it off peak traffic for most deployments. Cron syntax
  // from @nestjs/schedule: "second minute hour day-of-month month day-of-week".
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'purge-trash' })
  async handleCron() {
    // Multi-replica safety: only the leader runs this. Otherwise N
    // replicas would each fire deleteMany at 3am.
    if (!this.leader.shouldRun()) return;
    await this.purgeExpired();
  }

  /**
   * Exposed so admin tooling (or a dev "force now" button later) can
   * invoke the same code path the cron uses.
   */
  async purgeExpired() {
    const retentionDays = Number(
      this.cfg.get<string>('RECYCLE_BIN_RETENTION_DAYS', '30'),
    );
    if (!Number.isFinite(retentionDays) || retentionDays < 1) {
      this.log.warn(
        `RECYCLE_BIN_RETENTION_DAYS=${retentionDays} is invalid, skipping purge`,
      );
      return { items: 0, groups: 0 };
    }

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    // Per-row teardown so backing-storage cleanup runs (#115 P11).
    // Pre-fix this used a bulk deleteMany which left observation rows
    // and MinIO objects orphaned -- the visible symptom was disk usage
    // not budging after admins emptied the trash. Iterating items is
    // the slow path; for typical retention windows the candidate set
    // is tens-to-hundreds of rows, not thousands.
    const expiredItems = await this.prisma.item.findMany({
      where: { deletedAt: { lt: cutoff } },
      select: { id: true, type: true, data: true },
    });
    let itemsPurged = 0;
    for (const it of expiredItems) {
      try {
        await this.items.tearDownItemBackingStorage(
          it.id,
          it.type as ItemType,
          it.data,
        );
        // #238: the interactive purge path has always spliced the id
        // out of the lists that name it; this sweep did not, so an
        // item that simply aged out of the trash left a dead uuid in
        // every folder that held it and in the landing-page featured
        // pins. Same call, same place in the order: detach before the
        // row goes, so a failure leaves the item rather than a
        // half-detached graph.
        await this.items.detachPurgedItemReferences(it.id);
        await this.prisma.item.delete({ where: { id: it.id } });
        itemsPurged += 1;
      } catch (err) {
        // Log + continue. We don't want one bad row to halt the
        // whole sweep; it'll get another chance on tomorrow's run.
        this.log.warn(
          `Trash purge skipped item ${it.id}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }

    const groups = await this.prisma.group.deleteMany({
      where: { deletedAt: { lt: cutoff } },
    });

    this.log.log(
      `Purge swept trash older than ${retentionDays}d: items=${itemsPurged}, groups=${groups.count}`,
    );
    return { items: itemsPurged, groups: groups.count };
  }
}
