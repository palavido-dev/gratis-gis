import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ItemType } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import { KeycloakAdminService } from './keycloak-admin.service.js';
import {
  V3TablesService,
  type V3LayerShape,
} from '../features-v3/v3-tables.service.js';
import { HousekeepingService } from './housekeeping.service.js';

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
}

export interface HousekeepingConfigPatch {
  autoTrashEnabled?: boolean;
  autoTrashDays?: number | null;
  autoDisableEnabled?: boolean;
  autoDisableDays?: number | null;
  recomputeExtentsEnabled?: boolean;
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
    private readonly v3Tables: V3TablesService,
    private readonly housekeeping: HousekeepingService,
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
      scheduleMode: string;
      scheduleHour: number;
      scheduleMinute: number;
      scheduleDayOfWeek: number | null;
    } | null,
  ): HousekeepingConfig {
    const autoTrashDaysEnv = this.envInt('HOUSEKEEPING_STALE_ITEM_DAYS', 90);
    const autoDisableDaysEnv = this.envInt('HOUSEKEEPING_STALE_USER_DAYS', 180);
    const mode =
      (row?.scheduleMode as HousekeepingScheduleMode | undefined) ?? 'off';
    const hour = row?.scheduleHour ?? 3;
    const minute = row?.scheduleMinute ?? 0;
    const dow = row?.scheduleDayOfWeek ?? null;
    const autoTrash = row?.autoTrashEnabled ?? false;
    const autoDisable = row?.autoDisableEnabled ?? false;
    const recompute = row?.recomputeExtentsEnabled ?? false;

    let effectiveCron: string | null = null;
    let summary = 'Off';
    if (mode !== 'off' && (autoTrash || autoDisable || recompute)) {
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
    } else if (!autoTrash && !autoDisable && !recompute && mode !== 'off') {
      summary = 'Schedule set, but no auto-actions enabled';
    }

    return {
      autoTrashEnabled: autoTrash,
      autoTrashDays: row?.autoTrashDays ?? autoTrashDaysEnv,
      autoDisableEnabled: autoDisable,
      autoDisableDays: row?.autoDisableDays ?? autoDisableDaysEnv,
      recomputeExtentsEnabled: recompute,
      scheduleMode: mode,
      scheduleHour: hour,
      scheduleMinute: minute,
      scheduleDayOfWeek: dow,
      scheduleSummary: summary,
      effectiveCron,
    };
  }

  // ---------------------------------------------------------------
  // Run pass: auto-trash + auto-disable
  // ---------------------------------------------------------------

  async runOnce(args: {
    trigger: 'manual' | 'scheduled';
    startedBy: string | null;
  }): Promise<HousekeepingRunResult> {
    const cfg = await this.getConfig();
    const run = await this.prisma.housekeepingRun.create({
      data: {
        trigger: args.trigger,
        startedBy: args.startedBy,
        status: 'running',
      },
    });
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
   * shares). Item soft-delete is reversible from the trash, so
   * accidental over-trashing is recoverable.
   *
   * Per #95, "no recent edits" must include underlying feature
   * activity, not just item.updatedAt: a data_layer with active
   * feature edits is fresh even when nobody touched the item card.
   * We pull candidates by item.updatedAt then filter out anything
   * whose v3 layer tables show recent activity before trashing.
   */
  private async autoTrashStaleItems(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const candidates = await this.prisma.item.findMany({
      where: {
        deletedAt: null,
        updatedAt: { lt: cutoff },
        // Mirror staleItems(): an item recently hit through the
        // proxy can't be auto-trashed regardless of how stale the
        // item card looks. NULL lastUsageAt means "never used via
        // proxy"; the per-item refine still applies.
        OR: [{ lastUsageAt: null }, { lastUsageAt: { lt: cutoff } }],
        shares: { none: {} },
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
    // Build referenced-set per org so an item depended-on by any
    // non-trashed sibling stays alive (#98). Cached across the
    // candidate loop because a single org typically owns many
    // candidates and the helper does one query per org.
    const referencedByOrg = new Map<string, Set<string>>();
    const refSetFor = async (orgId: string): Promise<Set<string>> => {
      const cached = referencedByOrg.get(orgId);
      if (cached) return cached;
      const set = await this.housekeeping.buildReferencedItemSet(orgId);
      referencedByOrg.set(orgId, set);
      return set;
    };
    const toTrash: string[] = [];
    for (const c of candidates) {
      const referenced = await refSetFor(c.orgId);
      if (referenced.has(c.id)) continue;
      const dataAt = await this.dataActivityAt(c.id, c.type, c.data);
      let effective = c.updatedAt;
      if (dataAt && dataAt > effective) effective = dataAt;
      if (c.lastUsageAt && c.lastUsageAt > effective) effective = c.lastUsageAt;
      if (effective < cutoff) toTrash.push(c.id);
    }
    if (toTrash.length === 0) return 0;
    const res = await this.prisma.item.updateMany({
      where: { id: { in: toTrash } },
      data: { deletedAt: new Date() },
    });
    return res.count;
  }

  /**
   * Most recent feature-level activity for a v3 data_layer; null
   * for other types (caller falls back to item.updatedAt).
   * Mirrors HousekeepingService.dataActivityAt; duplicated here so
   * the auto-trash path doesn't need to depend on the analytics
   * service.
   */
  private async dataActivityAt(
    itemId: string,
    type: ItemType,
    data: unknown,
  ): Promise<Date | null> {
    if (type !== 'data_layer') return null;
    const layers = readV3Layers(data);
    if (layers === null || layers.length === 0) return null;
    return this.v3Tables.lastDataActivityAt(itemId, layers);
  }

  /**
   * Disable sign-in for users whose explicit auto_disable_at is in
   * the past (#85/#86). Always runs in the housekeeping pass, even
   * when the quiet-user heuristic is off: the admin set a hard end
   * date per-user, and that contract should hold whether or not
   * `autoDisableEnabled` is checked. Keycloak's `enabled=false` is
   * idempotent so re-running the same user is harmless.
   *
   * auth-sync rejects the request with 401 the moment the timestamp
   * passes (see auth-sync.service.ts), so this cron is the second
   * half of a belt-and-braces gate: Keycloak's enabled flag stops
   * the SSO refresh-token loop from minting fresh JWTs.
   */
  private async autoDisableExpiredUsers(): Promise<number> {
    const candidates = await this.prisma.user.findMany({
      where: {
        orgRole: { not: 'admin' },
        autoDisableAt: { not: null, lte: new Date() },
      },
      select: { id: true, username: true },
    });
    let count = 0;
    for (const u of candidates) {
      try {
        await this.keycloak.updateUser(u.id, { enabled: false });
        count += 1;
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
        OR: [
          { lastSeenAt: { lt: cutoff } },
          { AND: [{ lastSeenAt: null }, { createdAt: { lt: cutoff } }] },
        ],
      },
      select: { id: true, username: true },
    });
    let count = 0;
    for (const u of candidates) {
      try {
        await this.keycloak.updateUser(u.id, { enabled: false });
        count += 1;
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

/** Local mirror of items.service.readV3Layers. Duplicated here to
 *  avoid a DI cycle (ItemsModule -> AdminModule -> ItemsModule).
 *  Returns the per-layer shape the v3 tables need to query feature
 *  activity. */
function readV3Layers(data: unknown): V3LayerShape[] | null {
  if (!data || typeof data !== 'object') return null;
  const v = (data as { version?: unknown }).version;
  if (v !== 3 && v !== '3') return null;
  const layers = (data as { layers?: unknown }).layers;
  if (!Array.isArray(layers)) return null;
  const out: V3LayerShape[] = [];
  for (const l of layers) {
    if (!l || typeof l !== 'object') continue;
    const id = (l as { id?: unknown }).id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const gt = (l as { geometryType?: unknown }).geometryType;
    const geometryType: V3LayerShape['geometryType'] =
      gt === 'point' || gt === 'line' || gt === 'polygon' ? gt : null;
    out.push({ id, geometryType });
  }
  return out;
}
