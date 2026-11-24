// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger, type OnApplicationBootstrap, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';

import { RunAsSystem } from '../common/tenant-context.js';
import { LeaderElectionService } from '../cron/leader-election.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { runFeatureUsagePass } from './feature-usage.js';
import { isLowerUuid, objectKeyInStoredUrl, parseObjectKey, systemOwner } from './object-keys.js';
import { StorageLedgerService, isCountedKind } from './storage-ledger.service.js';
import { StorageService } from './storage.service.js';

const OWNER = systemOwner('cron:storage-usage-reconcile');

/** system_setting row holding the last reconcile's summary. */
export const LAST_RECONCILE_SETTING = 'storage_usage.last_reconcile';
/** system_setting row holding the backfill's resume point. */
export const BACKFILL_CURSOR_SETTING = 'storage_usage.backfill_cursor';

/** Keys kept in the summary as examples of objects no org could be found for. */
const UNATTRIBUTED_SAMPLE = 20;

/** A progress line every this many pages of a reconcile that asks for one. */
const PROGRESS_EVERY_PAGES = 10;

export interface ReconcileSummary {
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  /** Objects listed in the bucket (counted kinds only). */
  objectsSeen: number;
  bytesSeen: number;
  /** Objects the ledger did not have, recorded now. */
  recorded: number;
  /** Ledger rows whose size was wrong, corrected now. */
  resized: number;
  /** Ledger rows whose object is gone, marked deleted now. */
  markedDeleted: number;
  /** Objects no org could be found for. Reported, never deleted. */
  unattributed: number;
  unattributedSample: string[];
  /** Per org: bytes the totals moved by when recounted. */
  orgs: Array<{ orgId: string; bytesBefore: number; bytesAfter: number; drift: number }>;
  /** Set when the walk stopped early (backfill page limit). */
  resumeAfter: string | null;
  /** Orgs whose missing-object check stopped on a store error; nothing was marked deleted for them. */
  checkAborted?: string[];
}

type Attribution = { orgId: string; itemId: string | null };

/**
 * Compares the usage ledger with the bucket and repairs it.
 *
 * 1. One paged walk of the bucket (at most 1000 keys per call). Each
 *    object of a counted kind that the ledger lacks, or has at another
 *    size, is recorded at the listed size. The org comes from the key
 *    (`<kind>/o/<orgId>/...`) or, for older keys, from the row that
 *    references the object: the ledger itself, a feature attachment, an
 *    item's file fields, a map icon, an offline package, a feedback
 *    row, a thumbnail or avatar URL, or the item an older cached
 *    embedding is named after. Objects with no such row are counted and
 *    reported, never deleted.
 * 2. Per org, live ledger rows older than the walk whose object was not
 *    listed are marked deleted.
 * 3. Per org, the totals are set to the sum of the live rows, and the
 *    difference is stored as that org's drift.
 *
 * The daily run and the backfill script are the same code; the
 * backfill defaults to a dry run and can resume from a saved key.
 */
@Injectable()
export class StorageUsageReconcileService implements OnApplicationBootstrap {
  private readonly log = new Logger(StorageUsageReconcileService.name);
  /** The reconcile running in this process, if any. One at a time. */
  private running: Promise<ReconcileSummary> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly ledger: StorageLedgerService,
    @Optional() private readonly leader?: LeaderElectionService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'storage-usage-reconcile' })
  @RunAsSystem('cron:storage-usage-reconcile')
  async scheduled(): Promise<void> {
    if (this.leader && !this.leader.shouldRun()) return;
    if (this.running) return;
    try {
      await this.reconcile({ dryRun: false });
    } catch (err) {
      this.log.error(`Storage usage reconcile failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * On boot, start the first fill when the ledger has never been
   * filled. Not awaited: the API serves while it runs, and older files
   * stay readable under the earlier rules until it finishes.
   */
  onApplicationBootstrap(): void {
    void this.ensureFirstFill();
  }

  /**
   * Retry the first fill every five minutes until it has finished
   * once: a replica that becomes the leader later, or a fill that
   * failed, picks it up. A no-op (one cached flag) once filled.
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'storage-usage-first-fill' })
  async firstFillTick(): Promise<void> {
    await this.ensureFirstFill();
  }

  /**
   * Run the first full reconcile now, on the leader, when the durable
   * fill marker is absent. Returns what happened.
   */
  @RunAsSystem('cron:storage-usage-first-fill')
  async ensureFirstFill(): Promise<'filled' | 'ran' | 'skipped' | 'failed'> {
    try {
      if (await this.ledger.ledgerFilled()) return 'filled';
    } catch {
      return 'skipped';
    }
    if (this.leader && !this.leader.shouldRun()) return 'skipped';
    if (this.running) return 'skipped';
    this.log.warn(
      'Storage usage ledger has not been filled on this install. Running the first fill now. ' +
        'Until it finishes, files stored before the ledger existed are served under the item ' +
        'permission checks alone.',
    );
    const t0 = Date.now();
    try {
      const s = await this.reconcile({ dryRun: false, progress: true });
      this.log.log(
        `Storage usage first fill finished in ${Math.round((Date.now() - t0) / 1000)} s: ` +
          `${s.objectsSeen} objects, ${s.recorded} recorded, ${s.unattributed} with no owner. ` +
          'Older files are now checked against the ledger.',
      );
      return 'ran';
    } catch (err) {
      this.log.error(
        `Storage usage first fill failed; it is retried in a few minutes: ${err instanceof Error ? err.message : err}`,
      );
      return 'failed';
    }
  }

  /**
   * Nightly feature data pass: measure layers oldest first for at most
   * fifteen minutes. See feature-usage.ts for what is counted.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'feature-usage-measure' })
  @RunAsSystem('cron:feature-usage-measure')
  async scheduledFeaturePass(): Promise<void> {
    if (this.leader && !this.leader.shouldRun()) return;
    try {
      const r = await runFeatureUsagePass(this.prisma, { budgetMs: 15 * 60 * 1000 });
      this.log.log(
        `feature usage: ${r.measured} layers measured, ${r.failed} failed, ${r.remaining} left for next time`,
      );
    } catch (err) {
      this.log.error(`Feature usage pass failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Run once. `maxPages` stops the walk early (the backfill's resume
   * point is then saved); a stopped walk skips steps 2 and 3, which
   * need the whole bucket.
   */
  async reconcile(opts: {
    dryRun: boolean;
    startAfter?: string;
    maxPages?: number;
    log?: (line: string) => void;
    /** Log a line every few pages (the first fill). */
    progress?: boolean;
  }): Promise<ReconcileSummary> {
    if (this.running)
      throw new Error('A storage usage reconcile is already running in this process.');
    const run = this.reconcileOnce(opts);
    this.running = run;
    try {
      return await run;
    } finally {
      this.running = null;
    }
  }

  private async reconcileOnce(opts: {
    dryRun: boolean;
    startAfter?: string;
    maxPages?: number;
    log?: (line: string) => void;
    progress?: boolean;
  }): Promise<ReconcileSummary> {
    const started = new Date();
    const say = opts.log ?? ((l: string) => this.log.log(l));
    const s: ReconcileSummary = {
      startedAt: started.toISOString(),
      finishedAt: '',
      dryRun: opts.dryRun,
      objectsSeen: 0,
      bytesSeen: 0,
      recorded: 0,
      resized: 0,
      markedDeleted: 0,
      unattributed: 0,
      unattributedSample: [],
      orgs: [],
      resumeAfter: null,
    };
    const refs = await this.loadSmallReferenceMaps();
    // Per org, the live ledger rows (created before the walk) whose
    // object the walk saw. Compared with the ledger in step 2.
    const seenPerOrg = new Map<string, number>();
    const orgsTouched = new Set<string>();
    // Per org, what the repairs below moved the totals by.
    const drift = new Map<string, { bytes: number; objects: number }>();
    const addDrift = (orgId: string, bytes: number, objects: number): void => {
      const d = drift.get(orgId) ?? { bytes: 0, objects: 0 };
      drift.set(orgId, { bytes: d.bytes + bytes, objects: d.objects + objects });
    };
    let pages = 0;
    let lastKey: string | null = null;

    for await (const page of this.storage.listObjectPages('', OWNER, opts.startAfter)) {
      pages += 1;
      const counted = page.filter((o) => {
        const kind = parseObjectKey(o.key)?.kind;
        return kind === undefined || isCountedKind(kind);
      });
      const live = await this.ledger.liveRows(counted.map((o) => o.key));
      const needOwner = counted.filter((o) => !live.has(o.key)).map((o) => o.key);
      const owners = await this.attribute(needOwner, refs);
      for (const obj of counted) {
        s.objectsSeen += 1;
        s.bytesSeen += obj.sizeBytes;
        const row = live.get(obj.key);
        if (row) {
          if (row.createdAt < started)
            seenPerOrg.set(row.orgId, (seenPerOrg.get(row.orgId) ?? 0) + 1);
          if (row.bytes !== obj.sizeBytes) {
            s.resized += 1;
            orgsTouched.add(row.orgId);
            addDrift(row.orgId, obj.sizeBytes - row.bytes, 0);
            if (!opts.dryRun) await this.recordListed(obj.key, row.orgId, obj.sizeBytes, null);
          }
          continue;
        }
        const owner = owners.get(obj.key);
        const parsed = parseObjectKey(obj.key);
        if (!owner || !parsed) {
          s.unattributed += 1;
          if (s.unattributedSample.length < UNATTRIBUTED_SAMPLE) s.unattributedSample.push(obj.key);
          continue;
        }
        s.recorded += 1;
        orgsTouched.add(owner.orgId);
        addDrift(owner.orgId, obj.sizeBytes, 1);
        if (!opts.dryRun)
          await this.recordListed(obj.key, owner.orgId, obj.sizeBytes, owner.itemId);
      }
      lastKey = page.length > 0 ? page[page.length - 1]!.key : lastKey;
      if (opts.progress && pages % PROGRESS_EVERY_PAGES === 0) {
        say(
          `storage usage reconcile running: ${s.objectsSeen} objects so far, ${s.recorded} recorded`,
        );
      }
      if (opts.maxPages !== undefined && pages >= opts.maxPages) {
        s.resumeAfter = lastKey;
        break;
      }
    }

    if (s.resumeAfter === null) {
      // Step 2: rows whose object was not listed.
      const orgs = new Set([...(await this.ledger.orgsWithUsage()), ...orgsTouched]);
      for (const orgId of orgs) {
        let gone: string[];
        try {
          gone = await this.findMissing(orgId, started, seenPerOrg.get(orgId) ?? 0);
        } catch (err) {
          // Only a missing object means gone. A store error leaves this
          // org's rows as they are until the next run.
          (s.checkAborted ??= []).push(orgId);
          say(
            `storage usage reconcile: missing-object check for org ${orgId} stopped on a store error; ` +
              `nothing marked deleted: ${err instanceof Error ? err.message : err}`,
          );
          continue;
        }
        s.markedDeleted += gone.length;
        for (const key of gone) {
          const delta = opts.dryRun ? 0 : await this.ledger.markDeleted(key, orgId);
          addDrift(orgId, delta, -1);
        }
        if (gone.length > 0) orgsTouched.add(orgId);
      }
      // Step 3: totals from the rows.
      for (const orgId of orgs) {
        if (opts.dryRun) continue;
        // The totals also move when they disagree with the rows.
        const r = await this.ledger.recountOrg(orgId, drift.get(orgId));
        const d = (drift.get(orgId)?.bytes ?? 0) + (r.bytesAfter - r.bytesBefore);
        s.orgs.push({ orgId, bytesBefore: r.bytesBefore, bytesAfter: r.bytesAfter, drift: d });
        if (d !== 0) say(`storage usage drift for org ${orgId}: ${d} bytes repaired`);
      }
    }
    s.finishedAt = new Date().toISOString();
    say(
      `storage usage reconcile${opts.dryRun ? ' (dry run)' : ''}: ${s.objectsSeen} objects, ` +
        `${s.recorded} recorded, ${s.resized} resized, ${s.markedDeleted} gone, ` +
        `${s.unattributed} with no owner`,
    );
    if (!opts.dryRun && s.resumeAfter === null) {
      await this.saveSummary(s);
      // The whole bucket has been walked and recorded: from now on an
      // older key the ledger does not know is refused where an org is
      // required.
      await this.ledger.markFilled();
    }
    return s;
  }

  /** The last saved summary, for the operator page and metrics. */
  async lastSummary(): Promise<ReconcileSummary | null> {
    const row = await this.prisma.systemSetting.findUnique({
      where: { key: LAST_RECONCILE_SETTING },
    });
    return (row?.value as ReconcileSummary | undefined) ?? null;
  }

  private async saveSummary(s: ReconcileSummary): Promise<void> {
    const value = s as unknown as Prisma.InputJsonValue;
    await this.prisma.systemSetting.upsert({
      where: { key: LAST_RECONCILE_SETTING },
      create: { key: LAST_RECONCILE_SETTING, value },
      update: { value },
    });
  }

  private async recordListed(
    key: string,
    orgId: string,
    bytes: number,
    itemId: string | null,
  ): Promise<void> {
    const kind = parseObjectKey(key)?.kind;
    if (!kind) return;
    await this.ledger.record({ key, orgId, kind, bytes, itemId });
  }

  /**
   * Live rows of `orgId` older than the walk whose object is gone. The
   * cheap case (every such row was seen) costs one count. Otherwise the
   * rows are checked a page at a time against the store.
   */
  private async findMissing(orgId: string, started: Date, seen: number): Promise<string[]> {
    const live = await this.prisma.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS n FROM storage_object
       WHERE org_id = ${orgId}::uuid AND deleted_at IS NULL AND created_at < ${started}`);
    if (Number(live[0]?.n ?? 0n) <= seen) return [];
    const gone: string[] = [];
    let after = '';
    for (;;) {
      const keys = await this.ledger.liveKeysOfOrg(orgId, started, after, 500);
      if (keys.length === 0) break;
      for (const key of keys) {
        if ((await this.storage.headObjectSizeStrict(key, OWNER)) === null) gone.push(key);
      }
      after = keys[keys.length - 1]!;
    }
    return gone;
  }

  /**
   * Keys of small tables, read once per run: map icons, offline
   * packages, feedback screenshots, and the public image URLs on
   * items, groups, users and organizations.
   */
  private async loadSmallReferenceMaps(): Promise<Map<string, Attribution>> {
    const out = new Map<string, Attribution>();
    // Oldest row first and the first row wins, so a key copied onto a
    // later row (before attach paths checked ownership) stays with the
    // row that first stored it, the same rule as attachments below.
    const first = (key: string, a: Attribution): void => {
      if (!out.has(key)) out.set(key, a);
    };
    const icons = await this.prisma.mapIconUpload.findMany({
      select: { storageKey: true, orgId: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const r of icons) first(r.storageKey, { orgId: r.orgId, itemId: null });
    const packages = await this.prisma.offlinePackage.findMany({
      where: { storageKey: { not: null } },
      select: { storageKey: true, orgId: true, itemId: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const r of packages)
      if (r.storageKey) first(r.storageKey, { orgId: r.orgId, itemId: r.itemId });
    const shots = await this.prisma.feedback.findMany({
      where: { screenshotKey: { not: null }, orgId: { not: null } },
      select: { screenshotKey: true, orgId: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const r of shots)
      if (r.screenshotKey && r.orgId) first(r.screenshotKey, { orgId: r.orgId, itemId: null });
    // Public images are stored as URLs ending in the key.
    const images = await this.prisma.$queryRaw<
      Array<{ url: string; org_id: string; item_id: string | null }>
    >(
      Prisma.sql`
        SELECT url, org_id, item_id FROM (
          SELECT thumbnail_url AS url, org_id::text AS org_id, id::text AS item_id, created_at
            FROM item WHERE thumbnail_url LIKE ${'%/item-thumb/%'}
          UNION ALL
          SELECT thumbnail_url, org_id::text, NULL, created_at FROM "group" WHERE thumbnail_url LIKE ${'%/group-thumb/%'}
          UNION ALL
          SELECT avatar_url, org_id::text, NULL, created_at FROM "user" WHERE avatar_url LIKE ${'%/user-avatar/%'}
          UNION ALL
          SELECT landing_hero_image_url, id::text, NULL, created_at FROM organization
           WHERE landing_hero_image_url LIKE ${'%/org-hero/%'}
        ) images
        ORDER BY created_at, url`,
    );
    for (const r of images) {
      const key = keyInUrl(r.url);
      if (key) first(key, { orgId: r.org_id, itemId: r.item_id });
    }
    return out;
  }

  /** The org (and item) each key belongs to, for keys the ledger has no live row for. */
  private async attribute(
    keys: string[],
    refs: Map<string, Attribution>,
  ): Promise<Map<string, Attribution>> {
    const out = new Map<string, Attribution>();
    const rest: string[] = [];
    for (const key of keys) {
      const parsed = parseObjectKey(key);
      if (!parsed) continue;
      if (parsed.orgId) out.set(key, { orgId: parsed.orgId, itemId: null });
      else if (refs.has(key)) out.set(key, refs.get(key)!);
      else rest.push(key);
    }
    if (rest.length === 0) return out;
    // A deleted ledger row still names the owner of a key.
    const known = await this.prisma.$queryRaw<Array<{ key: string; org_id: string }>>(Prisma.sql`
      SELECT key, org_id::text AS org_id FROM storage_object WHERE key = ANY(${rest}::text[])`);
    for (const r of known) out.set(r.key, { orgId: r.org_id, itemId: null });
    const attachments = await this.prisma.$queryRaw<
      Array<{ key: string; org_id: string; item_id: string }>
    >(
      Prisma.sql`
        SELECT DISTINCT ON (fa.storage_key) fa.storage_key AS key, i.org_id::text AS org_id, i.id::text AS item_id
          FROM feature_attachment fa JOIN item i ON i.id = fa.item_id
         WHERE fa.storage_key = ANY(${rest}::text[])
         ORDER BY fa.storage_key, fa.created_at`,
    );
    for (const r of attachments)
      if (!out.has(r.key)) out.set(r.key, { orgId: r.org_id, itemId: r.item_id });
    const itemKeys = rest.filter((k) => !out.has(k));
    if (itemKeys.length > 0) {
      // Each probe is served by item_data_gin or the storage_ref index.
      const items = await this.prisma.$queryRaw<
        Array<{ key: string; org_id: string; item_id: string }>
      >(
        Prisma.sql`
          SELECT k.key, i.org_id::text AS org_id, i.id::text AS item_id
            FROM unnest(${itemKeys}::text[]) AS k(key)
            JOIN LATERAL (
              SELECT org_id, id FROM item
               WHERE storage_ref = k.key
                  OR data_json @> jsonb_build_object('storageKey', k.key)
                  OR data_json @> jsonb_build_object('cogStorageKey', k.key)
                  OR data_json @> jsonb_build_object('pmtilesStorageKey', k.key)
                  OR data_json @> jsonb_build_object('publicImageKey', k.key)
                  OR data_json @> jsonb_build_object(
                       'sources', jsonb_build_array(jsonb_build_object('storageKey', k.key)))
               ORDER BY created_at
               LIMIT 1
            ) i ON true`,
      );
      for (const r of items) out.set(r.key, { orgId: r.org_id, itemId: r.item_id });
    }
    // Older cached embeddings are named after their imagery item.
    const embedItems = new Map<string, string[]>();
    for (const key of rest) {
      const parsed = parseObjectKey(key);
      if (out.has(key) || parsed?.kind !== 'sam-embed') continue;
      const itemId = parsed.rest.split('/')[0]!;
      embedItems.set(itemId, [...(embedItems.get(itemId) ?? []), key]);
    }
    if (embedItems.size > 0) {
      const ids = [...embedItems.keys()].filter((id) => isLowerUuid(id));
      const rows = await this.prisma.item.findMany({
        where: { id: { in: ids } },
        select: { id: true, orgId: true },
      });
      for (const r of rows)
        for (const key of embedItems.get(r.id) ?? [])
          out.set(key, { orgId: r.orgId, itemId: r.id });
    }
    return out;
  }
}

/** The object key at the end of a stored public URL, or null. */
export function keyInUrl(url: string): string | null {
  return objectKeyInStoredUrl(url);
}
