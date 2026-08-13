// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Flag that the restore flow raises while it is actively rewriting
 * the database + object store. A global middleware reads it and
 * short-circuits unrelated requests with 503 so a live user session
 * can't race a destructive restore.
 *
 * The flag is backed by a `system_setting` row (key `maintenance`)
 * and mirrored into an in-memory cache refreshed on a short poll, so
 * the middleware stays a synchronous boolean read while BOTH
 * portal-api replicas honour a restore triggered on either of them.
 * The earlier in-memory-only flag quiesced only the replica that
 * received the restore POST; the other kept serving reads and writes
 * against a schema being dropped. Prod runs two replicas.
 *
 * The replica that triggers a restore sets its own cache immediately
 * (so it is in maintenance before the first poll), and the DB write
 * propagates to the other replica within one poll interval.
 */
const MAINTENANCE_KEY = 'maintenance';
const POLL_MS = 2_000;

type MaintenanceValue = {
  active: boolean;
  reason: string | null;
  startedAt: string | null;
};

@Injectable()
export class MaintenanceModeService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(MaintenanceModeService.name);
  private active = false;
  private reason: string | null = null;
  private startedAt: Date | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
    this.pollTimer = setInterval(() => {
      void this.refresh();
    }, POLL_MS);
    // Never let the poll hold a process (or a Jest worker) open.
    this.pollTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  isActive(): boolean {
    return this.active;
  }

  snapshot() {
    return {
      active: this.active,
      reason: this.reason,
      startedAt: this.startedAt?.toISOString() ?? null,
    };
  }

  async activate(reason: string): Promise<void> {
    if (this.active) {
      this.log.warn(
        `activate() called while maintenance mode was already on (reason: ${this.reason}); keeping original reason + timestamp`,
      );
    } else {
      // Reflect locally at once so the triggering replica is in
      // maintenance before the next poll tick.
      this.active = true;
      this.reason = reason;
      this.startedAt = new Date();
      this.log.warn(`Maintenance mode ON: ${reason}`);
    }
    await this.write({
      active: true,
      reason: this.reason,
      startedAt: (this.startedAt ?? new Date()).toISOString(),
    });
  }

  async deactivate(): Promise<void> {
    if (this.active) {
      this.log.log(
        `Maintenance mode OFF (was on for ${Math.round(
          (Date.now() - (this.startedAt?.getTime() ?? Date.now())) / 1000,
        )}s)`,
      );
    }
    this.active = false;
    this.reason = null;
    this.startedAt = null;
    await this.write({ active: false, reason: null, startedAt: null });
  }

  private applyValue(value: MaintenanceValue | null): void {
    if (!value || value.active !== true) {
      this.active = false;
      this.reason = null;
      this.startedAt = null;
      return;
    }
    this.active = true;
    this.reason = value.reason;
    this.startedAt = value.startedAt ? new Date(value.startedAt) : null;
  }

  private async refresh(): Promise<void> {
    try {
      const row = await this.prisma.systemSetting.findUnique({
        where: { key: MAINTENANCE_KEY },
      });
      this.applyValue((row?.value as MaintenanceValue | undefined) ?? null);
    } catch (err) {
      // Keep the last known state rather than flapping if the DB is
      // briefly unreachable. A restore that has already dropped the
      // schema is exactly when a read can fail, and losing the flag
      // then would reopen the portal mid-restore.
      this.log.warn(
        `maintenance-mode refresh failed, keeping last known state: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  private async write(value: MaintenanceValue): Promise<void> {
    await this.prisma.systemSetting.upsert({
      where: { key: MAINTENANCE_KEY },
      create: { key: MAINTENANCE_KEY, value },
      update: { value },
    });
  }
}
