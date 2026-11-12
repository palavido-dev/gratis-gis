// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { DataSnapshotService } from '../items/data-snapshot.service.js';
import { LeaderElectionService } from '../cron/leader-election.service.js';

/**
 * Nightly sweep that drops ItemDataSnapshot rows past their TTL or
 * beyond the per-item cap. The cap is also enforced inline whenever a
 * snapshot is written (see DataSnapshotService.enforceCap), so this
 * cron's main job is the age-based prune plus a safety net for the
 * cap in case inline enforcement ever gets skipped (e.g. a crash
 * mid-transaction).
 *
 * Retention knobs live on DataSnapshotService itself
 * (ITEM_SNAPSHOT_TTL_DAYS / ITEM_SNAPSHOT_CAP_PER_ITEM).
 */
@Injectable()
export class SnapshotPurgeService {
  private readonly log = new Logger(SnapshotPurgeService.name);

  constructor(
    private readonly snapshots: DataSnapshotService,
    private readonly leader: LeaderElectionService,
  ) {}

  // 3:15am UTC, staggered off the trash purge (3:00) so they don't
  // both wake the DB at the same instant. The time zone is explicit so
  // "UTC" holds whatever the container clock is set to.
  @Cron('0 15 3 * * *', { name: 'purge-snapshots', timeZone: 'UTC' })
  async handleCron() {
    if (!this.leader.shouldRun()) return;
    const res = await this.snapshots.purge();
    this.log.log(
      `Snapshot purge: removedByAge=${res.removedByAge}, removedByCap=${res.removedByCap}`,
    );
  }
}
