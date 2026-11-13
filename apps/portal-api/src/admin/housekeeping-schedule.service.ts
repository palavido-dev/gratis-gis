// SPDX-License-Identifier: AGPL-3.0-or-later
import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service.js';
import { KeycloakAdminService } from './keycloak-admin.service.js';
import { KeycloakSyncService } from './keycloak-sync.service.js';
import { DataLayerTablesService } from '../data-layer/tables.service.js';
import {
  HousekeepingService,
  staleCandidateWhere,
} from './housekeeping.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { disableLocalAccount } from '../auth/account-disable.js';

/**
 * A run row still marked `running` after this long belongs to a
 * process that died; it no longer blocks a new run.
 */
const STALE_RUN_MS = 6 * 60 * 60 * 1000;

export type HousekeepingScheduleMode = 'off' | 'daily' | 'weekly';

/**
 * Config the admin form edits. Effective values: any DB-row null
 * resolves to the env default so the UI can show what will actually
 * run without having to know the fallback chain.
 */
export interface HousekeepingConfig {
  autoTrashEnabled: boolean;
  autoTrashDays: number;
  autoDisableEnabled: boolean;
  autoDisableDays: number;
  /** When true, the periodic pass recomputes item.bbox for every
   *  spatial item alongside the trash + disable passes (#93). */
  recomputeExtentsEnabled: boolean;
  /** #276: how many days an empty field-queue manifest can sit idle
   *  before the admin field-queues view hides it by default + the
   *  bulk-forget endpoint considers it stale. */
  fieldQueueStaleDays: number;
  /** #276: when true, the periodic pass deletes empty field-queue
   *  manifest rows older than (fieldQueueStaleDays +
   *  fieldQueueAutoPruneGraceDays). Off by default; admin opts in. */
  fieldQueueAutoPruneEnabled: boolean;
  /** #276: extra cushion past the stale threshold before the cron
   *  actually deletes a row. Defaults so the auto-prune is
   *  conservative. */
  fieldQueueAutoPruneGraceDays: number;
  scheduleMode: HousekeepingScheduleMode;
  scheduleHour: number;
  scheduleMinute: number;
  scheduleDayOfWeek: number | null;
  /** Display-only: plain-English schedule summary. */
  scheduleSummary: string;
  /** Display-only: cron expression the scheduler is actually
   *  registered with, or null when mode='off' or both auto-actions
   *  are disabled (nothing to run). */
  effectiveCron: string | null;
  /** Display-only: the time zone the hour and minute are read in.
   *  The cron job is registered with no zone, so it fires in the API
   *  process's zone (UTC in the shipped containers), and the form
   *  says so. */
  timeZone: string;
}

export interface HousekeepingConfigPatch {
  autoTrashEnabled?: boolean;
  autoTrashDays?: number | null;
  autoDisableEnabled?: boolean;
  autoDisableDays?: number | null;
  recomputeExtentsEnabled?: boolean;
  fieldQueueStaleDays?: number | null;
  fieldQueueAutoPruneEnabled?: boolean;
  fieldQueueAutoPruneGraceDays?: number | null;
  scheduleMode?: HousekeepingScheduleMode;
  scheduleHour?: number;
  scheduleMinute?: number;
  scheduleDayOfWeek?: number | null;
}

export interface HousekeepingRunResult {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'succeeded' | 'failed';
  trigger: 'manual' | 'scheduled';
  itemsTrashed: number;
  usersDisabled: number;
  error: string | null;
}

/**
 * Owns the singleton HousekeepingConfig row, the auto-action passes,
 * and the HousekeepingRun audit log. Mirrors BackupService's shape so
 * the cron service can subscribe to config changes the same way.
 */
@Injectable()
export class HousekeepingScheduleService {
  private readonly log = new Logger(HousekeepingScheduleService.name);
  private listeners: Array<(cfg: HousekeepingConfig) => void> = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: ConfigService,
    private readonly keycloak: KeycloakAdminService,
    private readonly keycloakSync: KeycloakSyncService,
    private readonly dataLayerTables: DataLayerTablesService,
    private readonly housekeeping: HousekeepingService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------

  async getConfig(): Promise<HousekeepingConfig> {
    const row = await this.prisma.housekeepingConfig.findFirst();
    return this.materialize(row);
  }

  async updateConfig(patch: HousekeepingConfigPatch): Promise<HousekeepingConfig> {
    const existing = await this.prisma.housekeepingConfig.findFirst();
    const data: Record<string, unknown> = {};
    if (patch.autoTrashEnabled !== undefined)
      data.autoTrashEnabled = patch.autoTrashEnabled;
    if (patch.autoTrashDays !== undefined)
      data.autoTrashDays = patch.autoTrashDays;
    if (patch.autoDisableEnabled !== undefined)
      data.autoDisableEnabled = patch.autoDisableEnabled;
    if (patch.autoDisableDays !== undefined)
      data.autoDisableDays = patch.autoDisableDays;
    if (patch.recomputeExtentsEnabled !== undefined)
      data.recomputeExtentsEnabled = patch.recomputeExtentsEnabled;
    if (patch.fieldQueueStaleDays !== undefined)
      data.fieldQueueStaleDays = patch.fieldQueueStaleDays;
    if (patch.fieldQueueAutoPruneEnabled !== undefined)
      data.fieldQueueAutoPruneEnabled = patch.fieldQueueAutoPruneEnabled;
    if (patch.fieldQueueAutoPruneGraceDays !== undefined)
      data.fieldQueueAutoPruneGraceDays = patch.fieldQueueAutoPruneGraceDays;
    if (patch.scheduleMode !== undefined)
      data.scheduleMode = patch.scheduleMode;
    if (patch.scheduleHour !== undefined) data.scheduleHour = patch.scheduleHour;
    if (patch.scheduleMinute !== undefined)
      data.scheduleMinute = patch.scheduleMinute;
    if (patch.scheduleDayOfWeek !== undefined)
      data.scheduleDayOfWeek = patch.scheduleDayOfWeek;

    const row = existing
      ? await this.prisma.housekeepingConfig.update({
          where: { id: existing.id },
          data,
        })
      : await this.prisma.housekeepingConfig.create({ data });

    const next = this.materialize(row);
    for (const cb of this.listeners) {
      try {
        cb(next);
      } catch (err) {
        this.log.warn(
          `Config listener threw: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return next;
  }

  onConfigChange(cb: (cfg: HousekeepingConfig) => void): void {
    this.listeners.push(cb);
  }

  private envInt(key: string, fallback: number): number {
    const raw = Number(this.cfg.get<string>(key));
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
  }

  private materialize(
    row: {
      autoTrashEnabled: boolean;
      autoTrashDays: number | null;
      autoDisableEnabled: boolean;
      autoDisableDays: number | null;
      recomputeExtentsEnabled: boolean;
      fieldQueueStaleDays: number | null;
      fieldQueueAutoPruneEnabled: boolean;
      fieldQueueAutoPruneGraceDays: number | null;
      scheduleMode: string;
      scheduleHour: number;
      scheduleMinute: number;
      scheduleDayOfWeek: number | null;
    } | null,
  ): HousekeepingConfig {
    const autoTrashDaysEnv = this.envInt('HOUSEKEEPING_STALE_ITEM_DAYS', 90);
    const autoDisableDaysEnv = this.envInt('HOUSEKEEPING_STALE_USER_DAYS', 180);
    const fieldQueueStaleDaysEnv = this.envInt(
      'HOUSEKEEPING_FIELD_QUEUE_STALE_DAYS',
      7,
    );
    const fieldQueueGraceDaysEnv = this.envInt(
      'HOUSEKEEPING_FIELD_QUEUE_AUTO_PRUNE_GRACE_DAYS',
      90,
    );
    const mode =
      (row?.scheduleMode as HousekeepingScheduleMode | undefined) ?? 'off';
    const hour = row?.scheduleHour ?? 3;
    const minute = row?.scheduleMinute ?? 0;
    const dow = row?.scheduleDayOfWeek ?? null;
    const autoTrash = row?.autoTrashEnabled ?? false;
    const autoDisable = row?.autoDisableEnabled ?? false;
    const recompute = row?.recomputeExtentsEnabled ?? false;
    const fieldQueueAutoPrune = row?.fieldQueueAutoPruneEnabled ?? false;

    // Any mode but 'off' gets a cron, even with every toggle off: the
    // end-date account disable and the Keycloak user sync in runOnce
    // are not behind a toggle, so they need the schedule to run
    // (03-7).
    let effectiveCron: string | null = null;
    let summary = 'Off';
    if (mode !== 'off') {
      const m = String(minute).padStart(2, '0');
      const h = String(hour).padStart(2, '0');
      if (mode === 'daily') {
        effectiveCron = `${minute} ${hour} * * *`;
        summary = `Daily at ${h}:${m}`;
      } else if (mode === 'weekly') {
        const d = dow ?? 1;
        effectiveCron = `${minute} ${hour} * * ${d}`;
        const dayName =
          ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d] ?? 'Monday';
        summary = `Weekly on ${dayName} at ${h}:${m}`;
      }
      if (!autoTrash && !autoDisable && !recompute && !fieldQueueAutoPrune) {
        summary += ' (account end dates and user sync only)';
      }
    }

    return {
      autoTrashEnabled: autoTrash,
      autoTrashDays: row?.autoTrashDays ?? autoTrashDaysEnv,
      autoDisableEnabled: autoDisable,
      autoDisableDays: row?.autoDisableDays ?? autoDisableDaysEnv,
      recomputeExtentsEnabled: recompute,
      fieldQueueStaleDays:
        row?.fieldQueueStaleDays ?? fieldQueueStaleDaysEnv,
      fieldQueueAutoPruneEnabled: fieldQueueAutoPrune,
      fieldQueueAutoPruneGraceDays:
        row?.fieldQueueAutoPruneGraceDays ?? fieldQueueGraceDaysEnv,
      scheduleMode: mode,
      scheduleHour: hour,
      scheduleMinute: minute,
      scheduleDayOfWeek: dow,
      scheduleSummary: summary,
      effectiveCron,
      timeZone: serverTimeZone(),
    };
  }

  /**
   * Mark runs left 'running' as failed (03-12). Called once at API
   * start by the leader: a run row is only finalized by the process
   * that started it, so after a restart (deploy, OOM) the row would
   * otherwise stay 'running', block Run now for STALE_RUN_MS and show
   * as running in the history forever. If the run was in fact still
   * going on another replica, its own final update overwrites this.
   */
  async failInterruptedRuns(): Promise<number> {
    const r = await this.prisma.housekeepingRun.updateMany({
      where: { status: 'running' },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        error: 'The server restarted before this run finished.',
      },
    });
    if (r.count > 0) {
      this.log.warn(`Marked ${r.count} interrupted housekeeping run(s) failed.`);
    }
    return r.count;
  }

  // ---------------------------------------------------------------
  // Run pass: auto-trash + auto-disable
  // ---------------------------------------------------------------

  async runOnce(args: {
    trigger: 'manual' | 'scheduled';
    startedBy: string | null;
  }): Promise<HousekeepingRunResult> {
    const cfg = await this.getConfig();
    // One run at a time across replicas. The advisory lock serialises
    // the check and the insert; the `running` row is what the next
    // caller sees while this run works.
    const run = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('housekeeping_run'))`;
      const live = await tx.housekeepingRun.findFirst({
        where: {
          status: 'running',
          startedAt: { gt: new Date(Date.now() - STALE_RUN_MS) },
        },
        select: { id: true },
      });
      if (live) return null;
      return tx.housekeepingRun.create({
        data: {
          trigger: args.trigger,
          startedBy: args.startedBy,
          status: 'running',
        },
      });
    });
    if (!run) {
      throw new ConflictException('A housekeeping run is already in progress.');
    }
    let itemsTrashed = 0;
    let usersDisabled = 0;
    let error: string | null = null;
    try {
      if (cfg.autoTrashEnabled) {
        itemsTrashed = await this.autoTrashStaleItems(cfg.autoTrashDays);
      }
      if (cfg.autoDisableEnabled) {
        usersDisabled = await this.autoDisableQuietUsers(cfg.autoDisableDays);
      }
      // Auto-disable for users with an explicit auto_disable_at in
      // the past (#85/#86). Runs unconditionally: the admin set an
      // explicit end date per-user, so this isn't gated by the
      // quiet-user heuristic toggle. Counts roll into usersDisabled
      // for the audit log so "X users disabled" stays one number;
      // logger output below distinguishes the cause.
      const expired = await this.autoDisableExpiredUsers();
      usersDisabled += expired;
      // Optional periodic recompute-extents (#93). Loops every org
      // and recomputes their spatial item bboxes. Cheap for a
      // typical pure-data_layer org; with arcgis services it does
      // N HTTP probes so the toggle is explicit-opt-in. Failures
      // on a single org are logged and we move on; one bad org
      // can't black out the whole sweep.
      if (cfg.recomputeExtentsEnabled) {
        const orgs = await this.prisma.organization.findMany({
          select: { id: true, slug: true },
        });
        for (const org of orgs) {
          try {
            const result = await this.housekeeping.recomputeExtents(org.id);
            this.log.log(
              `recompute-extents (${org.slug}): ${result.updated}/${result.scanned} items refreshed`,
            );
          } catch (err) {
            this.log.warn(
              `recompute-extents failed for org ${org.slug}: ${
                err instanceof Error ? err.message : err
              }`,
            );
          }
        }
      }
      // #276: auto-prune stale field-queue manifests. Deletes rows
      // whose manifest is empty AND whose last beacon is older than
      // (staleDays + graceDays). Off by default; admin opts in.
      // Deliberately conservative -- a row with non-empty queue is
      // signal even if silent, and the grace window ensures we
      // don't delete a row a worker could still come back to.
      if (cfg.fieldQueueAutoPruneEnabled) {
        const totalDays =
          cfg.fieldQueueStaleDays + cfg.fieldQueueAutoPruneGraceDays;
        const cutoff = new Date(Date.now() - totalDays * 24 * 60 * 60 * 1000);
        const candidates = await this.prisma.fieldQueueManifest.findMany({
          where: { reportedAt: { lt: cutoff } },
          select: { id: true, manifest: true },
        });
        const stale = candidates.filter((r) => {
          const m = (r.manifest as Array<{
            queuedRecords?: Array<unknown>;
          }> | null) ?? [];
          return m.every(
            (entry) => (entry.queuedRecords?.length ?? 0) === 0,
          );
        });
        if (stale.length > 0) {
          const result = await this.prisma.fieldQueueManifest.deleteMany({
            where: { id: { in: stale.map((r) => r.id) } },
          });
          this.log.log(
            `field-queue-auto-prune: deleted ${result.count} manifests (cutoff ${totalDays}d)`,
          );
        }
      }
      // Keycloak -> Prisma user mirror reconcile. Runs unconditionally
      // (not gated on a config toggle) because the cost is a single
      // realm scan per cron tick and an out-of-sync mirror surfaces
      // as ghost / missing users in the principal picker -- a class
      // of bug the eager pass exists to prevent. Self-skips when
      // Keycloak admin isn't configured. Failures don't abort the
      // run; the picker just stays as fresh as the previous tick.
      try {
        const summary = await this.keycloakSync.reconcileAll();
        if (!summary.skipped) {
          this.log.log(
            `keycloak-sync: realmUsers=${summary.realmUsersSeen} inserted=${summary.inserted} updated=${summary.updated} softDeleted=${summary.softDeleted}`,
          );
        }
      } catch (err) {
        this.log.warn(
          `keycloak-sync threw inside runOnce: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
      const finished = await this.prisma.housekeepingRun.update({
        where: { id: run.id },
        data: {
          status: 'succeeded',
          finishedAt: new Date(),
          itemsTrashed,
          usersDisabled,
        },
      });
      return this.toResult(finished);
    } catch (e) {
      error = (e as Error).message ?? String(e);
      const finished = await this.prisma.housekeepingRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          itemsTrashed,
          usersDisabled,
          error: error.slice(0, 500),
        },
      });
      this.log.error(
        `Housekeeping run ${run.id} failed: ${error}`,
      );
      return this.toResult(finished);
    }
  }

  /**
   * Soft-delete every item that matches the stale-item heuristic
   * from HousekeepingService.staleItems (no recent edits, zero
   * shares, nothing depends on it, not a seeded builtin). Item
   * soft-delete is reversible from the trash, so accidental
   * over-trashing is recoverable, but the trash purge later deletes
   * for good, so this pass is stricter than the report:
   *
   *   - Private items only. Org and public items can be read by
   *     people and anonymous visitors without leaving any usage
   *     stamp (public pages, OGC, STAC), so "nobody touched it" is
   *     not something we can know about them.
   *   - No folders. Trashing a folder needs the cascade and cohort
   *     that ItemsService.remove applies; a bare update would strand
   *     its children.
   *
   * Per #95, "no recent edits" includes feature activity, not just
   * item.updatedAt; the shared refine step checks it.
   */
  private async autoTrashStaleItems(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const candidates = await this.prisma.item.findMany({
      where: {
        ...staleCandidateWhere(undefined, cutoff),
        access: 'private',
        type: { not: 'folder' },
      },
      select: {
        id: true,
        orgId: true,
        type: true,
        data: true,
        updatedAt: true,
        lastUsageAt: true,
      },
    });
    const byOrg = new Map<string, typeof candidates>();
    for (const c of candidates) {
      const list = byOrg.get(c.orgId) ?? [];
      list.push(c);
      byOrg.set(c.orgId, list);
    }
    const toTrash: string[] = [];
    for (const [orgId, list] of byOrg) {
      // An item depended on by any live sibling stays (#98).
      const referenced = await this.housekeeping.buildReferencedItemSet(orgId, {
        fresh: true,
      });
      const stale = await this.housekeeping.refineStaleCandidates(
        list,
        referenced,
        cutoff,
      );
      toTrash.push(...stale.map((c) => c.id));
    }
    if (toTrash.length === 0) return 0;
    const res = await this.prisma.item.updateMany({
      where: { id: { in: toTrash }, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return res.count;
  }

  /**
   * Disable sign-in for users whose explicit auto_disable_at is in
   * the past (#85/#86). Always runs in the housekeeping pass, even
   * when the quiet-user heuristic is off: the admin set a hard end
   * date per-user, and that contract should hold whether or not
   * `autoDisableEnabled` is checked. Each user is handled once: the
   * pass stamps `disabled_at`, revokes the user's API keys, and skips
   * rows that already carry `disabled_at`.
   *
   * auth-sync rejects the request with 401 the moment the timestamp
   * passes (see auth-sync.service.ts), so this cron is the second
   * half of a belt-and-braces gate: Keycloak's enabled flag stops
   * the SSO refresh-token loop from minting fresh JWTs.
   */
  private async autoDisableExpiredUsers(): Promise<number> {
    // Users this pass (or an admin) already disabled carry disabledAt
    // and are not picked again, so each user is disabled and emailed
    // once.
    const candidates = await this.prisma.user.findMany({
      where: {
        orgRole: { not: 'admin' },
        deletedAt: null,
        disabledAt: null,
        autoDisableAt: { not: null, lte: new Date() },
      },
      select: { id: true, username: true, autoDisableAt: true },
    });
    let count = 0;
    for (const u of candidates) {
      try {
        // Resolve the Keycloak id from the username: u.id is the local
        // row id, which differs from the Keycloak sub for seeded /
        // pre-Keycloak users, so updateUser(u.id) would 404 and the
        // disable would silently never happen.
        const kcId = await this.keycloak.findUserIdByUsername(u.username);
        if (!kcId) {
          this.log.warn(
            `auto-disable (expired): no Keycloak user for ${u.username}; skipping`,
          );
          continue;
        }
        const wasEnabled = await this.disableInKeycloak(kcId);
        await disableLocalAccount(this.prisma, u.id);
        count += 1;
        // Fire user_disabled notification (#128) once: the row now
        // carries disabledAt, so the next run skips it. A user who was
        // already disabled in Keycloak (by an admin, before this
        // column existed) is marked locally but not emailed again.
        // Fire-and-forget: a notify failure shouldn't unflip the
        // Keycloak disable.
        if (u.autoDisableAt && wasEnabled) {
          void this.notifications.notify(u.id, 'user_disabled', {
            autoDisableAt: u.autoDisableAt.toISOString(),
          });
        }
      } catch (err) {
        this.log.warn(
          `auto-disable (expired): could not disable ${u.username} (${u.id}): ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }
    if (count > 0) {
      this.log.log(
        `auto-disable (expired): flipped Keycloak enabled=false on ${count} user(s).`,
      );
    }
    return count;
  }

  /**
   * Disable sign-in for users matching the quiet-user heuristic.
   * Per CLAUDE.md / the housekeeping page, admins are exempt
   * (break-glass accounts may legitimately be idle). Disable runs
   * through Keycloak so the SSO flow rejects the next login;
   * the local user row stays put for ownership integrity.
   *
   * Best-effort: a Keycloak failure on one user does not abort the
   * whole pass. We log and continue, so a flaky network doesn't
   * leave the run half-done.
   */
  private async autoDisableQuietUsers(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const candidates = await this.prisma.user.findMany({
      where: {
        orgRole: { not: 'admin' },
        deletedAt: null,
        disabledAt: null,
        OR: [
          { lastSeenAt: { lt: cutoff } },
          { AND: [{ lastSeenAt: null }, { createdAt: { lt: cutoff } }] },
        ],
      },
      select: { id: true, username: true },
    });
    let count = 0;
    const now = new Date();
    for (const u of candidates) {
      try {
        // See autoDisableExpiredUsers: resolve the Keycloak id by
        // username, since u.id is the local row id and would 404 for
        // seeded users.
        const kcId = await this.keycloak.findUserIdByUsername(u.username);
        if (!kcId) {
          this.log.warn(
            `auto-disable: no Keycloak user for ${u.username}; skipping`,
          );
          continue;
        }
        const wasEnabled = await this.disableInKeycloak(kcId);
        await disableLocalAccount(this.prisma, u.id, now);
        count += 1;
        // Quiet-user disable doesn't have a stored autoDisableAt
        // (the heuristic is the disable trigger). Use `now` as
        // the synthetic timestamp so the user sees a real "your
        // account was disabled on <today>" message. disabledAt keeps
        // the next run from picking the user again.
        if (wasEnabled) {
          void this.notifications.notify(u.id, 'user_disabled', {
            autoDisableAt: now.toISOString(),
          });
        }
      } catch (err) {
        this.log.warn(
          `auto-disable: could not disable ${u.username} (${u.id}): ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }
    return count;
  }

  /**
   * Turn sign-in off in Keycloak. Returns whether the account was
   * enabled before, so callers email only on a real change.
   */
  private async disableInKeycloak(kcId: string): Promise<boolean> {
    const current = await this.keycloak.getUser(kcId);
    if (current.enabled === false) return false;
    await this.keycloak.updateUser(kcId, { enabled: false });
    return true;
  }

  // ---------------------------------------------------------------
  // Run history
  // ---------------------------------------------------------------

  async listRuns(limit = 25): Promise<HousekeepingRunResult[]> {
    const rows = await this.prisma.housekeepingRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: Math.min(Math.max(1, limit), 200),
    });
    return rows.map((r) => this.toResult(r));
  }

  private toResult(r: {
    id: string;
    startedAt: Date;
    finishedAt: Date | null;
    status: 'running' | 'succeeded' | 'failed';
    trigger: string;
    itemsTrashed: number;
    usersDisabled: number;
    error: string | null;
  }): HousekeepingRunResult {
    return {
      id: r.id,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      status: r.status,
      trigger:
        r.trigger === 'scheduled' ? 'scheduled' : 'manual',
      itemsTrashed: r.itemsTrashed,
      usersDisabled: r.usersDisabled,
      error: r.error,
    };
  }
}

/** IANA name of the zone this process runs cron jobs in. */
export function serverTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
