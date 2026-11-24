// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import type { ObjectKind } from './object-keys.js';

/**
 * Kinds that are not counted as stored data: resumable import uploads
 * live under `ingest-upload/` only until the import reads them, and a
 * sweep removes any left behind within two days.
 */
export const UNCOUNTED_KINDS: ReadonlySet<ObjectKind> = new Set<ObjectKind>(['ingest-upload']);

export function isCountedKind(kind: string): boolean {
  return !UNCOUNTED_KINDS.has(kind as ObjectKind);
}

export interface LedgerEntry {
  key: string;
  orgId: string;
  kind: string;
  bytes: number;
  itemId?: string | null;
}

export interface OrgUsage {
  orgId: string;
  objectBytes: number;
  objects: number;
  featureBytes: number;
  featureCount: number;
  totalBytes: number;
  byKind: Array<{ kind: string; bytes: number; objects: number }>;
  updatedAt: Date | null;
  reconciledAt: Date | null;
}

type Tx = Prisma.TransactionClient;

/** system_setting row written when a full reconcile has filled the ledger. */
export const LEDGER_FILLED_SETTING = 'storage_usage.ledger_filled';

/** Older-layout keys whose owner is kept in memory. */
export const OWNER_CACHE_MAX = 10_000;

/** While the ledger is not filled, its marker is re-read at most this often. */
const FILLED_RECHECK_MS = 30_000;

/** A served embedding's read time is written at most this often. */
export const READ_TOUCH_EVERY_MS = 10 * 60 * 1000;

/**
 * A small least-recently-used map. Map keeps insertion order, so the
 * first entry is the oldest; a hit moves its entry to the end.
 */
export class BoundedLru<V> {
  private readonly map = new Map<string, V>();

  constructor(private readonly max: number) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * The storage usage ledger: `storage_object` (one row per stored
 * object) and `org_storage_usage` (running totals per org).
 *
 * Every change to an object row and the matching change to its org's
 * totals happen in one transaction. Lock order is always the object
 * row first, then the totals row, so concurrent uploads and deletes
 * cannot deadlock, and the totals row serialises the increments, so
 * twenty parallel uploads end with the exact sum.
 *
 * Every statement names one key or one org. With many organizations
 * the org is always given, except for system work (sweeps, the
 * reconcile) that runs without one.
 */
@Injectable()
export class StorageLedgerService {
  private readonly log = new Logger(StorageLedgerService.name);

  /**
   * Owners of older-layout keys already looked up. A ledger row's org
   * never changes (the first owner keeps the key), so a found owner
   * stays true; a miss is not kept, as the key may be recorded later.
   */
  private readonly owners = new BoundedLru<string>(OWNER_CACHE_MAX);
  private filled = false;
  private filledCheckedAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The org the ledger records for `key`, or null. Used by the owner
   * check for keys in the older layout, which carry no org. Range
   * reads of one file call this once per request, so found owners are
   * kept in a bounded in-memory cache.
   */
  async orgOfKey(key: string): Promise<string | null> {
    const hit = this.owners.get(key);
    if (hit !== undefined) return hit;
    const rows = await this.prisma.$queryRaw<Array<{ org_id: string }>>(Prisma.sql`
      SELECT org_id::text AS org_id FROM storage_object WHERE key = ${key} LIMIT 1`);
    const org = rows[0]?.org_id ?? null;
    if (org !== null) this.owners.set(key, org);
    return org;
  }

  /**
   * True once a full reconcile has filled the ledger on this install.
   * Read from a durable marker, never from whether the table is empty.
   * Once true it stays true for the life of the process.
   */
  async ledgerFilled(): Promise<boolean> {
    if (this.filled) return true;
    const now = Date.now();
    if (now - this.filledCheckedAt < FILLED_RECHECK_MS && this.filledCheckedAt !== 0) return false;
    this.filledCheckedAt = now;
    try {
      const row = await this.prisma.systemSetting.findUnique({ where: { key: LEDGER_FILLED_SETTING } });
      this.filled = row !== null;
    } catch (err) {
      this.log.warn(`Could not read the ledger fill marker: ${err instanceof Error ? err.message : err}`);
    }
    return this.filled;
  }

  /** Write the durable marker that the ledger has been filled once. */
  async markFilled(at: Date = new Date()): Promise<void> {
    const value = { at: at.toISOString() } as Prisma.InputJsonValue;
    await this.prisma.systemSetting.upsert({
      where: { key: LEDGER_FILLED_SETTING },
      create: { key: LEDGER_FILLED_SETTING, value },
      update: { value },
    });
    this.filled = true;
  }

  /**
   * Note that `key` was just served, for the per-item cap on cached
   * embeddings (least recently used first). Written at most once per
   * READ_TOUCH_EVERY_MS per key. Best effort.
   */
  async touchRead(key: string): Promise<void> {
    const cutoff = new Date(Date.now() - READ_TOUCH_EVERY_MS);
    try {
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE storage_object SET last_read_at = now()
         WHERE key = ${key} AND deleted_at IS NULL
           AND (last_read_at IS NULL OR last_read_at < ${cutoff})`);
    } catch (err) {
      this.log.warn(`Could not note a read of ${key}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Record that `entry.key` now holds `entry.bytes` bytes. Idempotent:
   * recording the same key and size again changes nothing; a new size
   * moves the totals by the difference; a key marked deleted comes
   * back to life. A key already recorded for another org is left
   * alone and logged: the first owner keeps it. Uncounted kinds are
   * ignored. Returns the change applied to the org's byte total.
   */
  async record(entry: LedgerEntry): Promise<number> {
    if (!isCountedKind(entry.kind)) return 0;
    const bytes = Math.max(0, Math.trunc(entry.bytes));
    return this.prisma.$transaction((tx) => recordInTx(tx, { ...entry, bytes }, this.log));
  }

  /**
   * Mark `key` deleted and take it off its org's totals. A key that is
   * unknown or already deleted changes nothing. `orgId`, when given,
   * limits the change to that org's row.
   */
  async markDeleted(key: string, orgId?: string): Promise<number> {
    return this.prisma.$transaction((tx) => markDeletedInTx(tx, key, orgId));
  }

  /** Usage for one org: object bytes by kind plus feature data. */
  async usage(orgId: string): Promise<OrgUsage> {
    const [totals, byKind] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          bytes: bigint;
          objects: bigint;
          feature_bytes: bigint;
          feature_count: bigint;
          updated_at: Date;
          reconciled_at: Date | null;
        }>
      >(Prisma.sql`
        SELECT bytes, objects, feature_bytes, feature_count, updated_at, reconciled_at
          FROM org_storage_usage WHERE org_id = ${orgId}::uuid`),
      this.prisma.$queryRaw<Array<{ kind: string; bytes: bigint; objects: bigint }>>(Prisma.sql`
        SELECT kind, COALESCE(SUM(bytes), 0)::bigint AS bytes, COUNT(*)::bigint AS objects
          FROM storage_object
         WHERE org_id = ${orgId}::uuid AND deleted_at IS NULL
         GROUP BY kind
         ORDER BY kind`),
    ]);
    const t = totals[0];
    const objectBytes = Number(t?.bytes ?? 0n);
    const featureBytes = Number(t?.feature_bytes ?? 0n);
    return {
      orgId,
      objectBytes,
      objects: Number(t?.objects ?? 0n),
      featureBytes,
      featureCount: Number(t?.feature_count ?? 0n),
      totalBytes: objectBytes + featureBytes,
      byKind: byKind.map((r) => ({
        kind: r.kind,
        bytes: Number(r.bytes),
        objects: Number(r.objects),
      })),
      updatedAt: t?.updated_at ?? null,
      reconciledAt: t?.reconciled_at ?? null,
    };
  }

  /**
   * Set one org's object totals to the sum of its live ledger rows and
   * return what changed. The stored drift is `repaired` (what the
   * reconcile changed in the rows) plus any gap between the totals and
   * the rows. The totals row is locked first, so an upload
   * that commits during the recount is either inside the sum or adds
   * itself after it, never both and never neither.
   */
  async recountOrg(
    orgId: string,
    repaired: { bytes: number; objects: number } = { bytes: 0, objects: 0 },
  ): Promise<{ bytesBefore: number; bytesAfter: number; objectsBefore: number; objectsAfter: number }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO org_storage_usage (org_id) VALUES (${orgId}::uuid)
        ON CONFLICT (org_id) DO NOTHING`);
      const before = await tx.$queryRaw<Array<{ bytes: bigint; objects: bigint }>>(Prisma.sql`
        SELECT bytes, objects FROM org_storage_usage WHERE org_id = ${orgId}::uuid FOR UPDATE`);
      const sum = await tx.$queryRaw<Array<{ bytes: bigint; objects: bigint }>>(Prisma.sql`
        SELECT COALESCE(SUM(bytes), 0)::bigint AS bytes, COUNT(*)::bigint AS objects
          FROM storage_object WHERE org_id = ${orgId}::uuid AND deleted_at IS NULL`);
      const after = sum[0] ?? { bytes: 0n, objects: 0n };
      const driftBytes =
        BigInt(Math.trunc(repaired.bytes)) + after.bytes - (before[0]?.bytes ?? 0n);
      const driftObjects =
        Math.trunc(repaired.objects) + Number(after.objects - (before[0]?.objects ?? 0n));
      await tx.$executeRaw(Prisma.sql`
        UPDATE org_storage_usage
           SET bytes = ${after.bytes}, objects = ${after.objects},
               reconciled_at = now(), drift_bytes = ${driftBytes},
               drift_objects = ${driftObjects}, updated_at = now()
         WHERE org_id = ${orgId}::uuid`);
      return {
        bytesBefore: Number(before[0]?.bytes ?? 0n),
        bytesAfter: Number(after.bytes),
        objectsBefore: Number(before[0]?.objects ?? 0n),
        objectsAfter: Number(after.objects),
      };
    });
  }

  /** Live ledger rows among `keys`, with their org and size. */
  async liveRows(keys: string[]): Promise<Map<string, { orgId: string; bytes: number; createdAt: Date }>> {
    const out = new Map<string, { orgId: string; bytes: number; createdAt: Date }>();
    if (keys.length === 0) return out;
    const rows = await this.prisma.$queryRaw<
      Array<{ key: string; org_id: string; bytes: bigint; created_at: Date }>
    >(Prisma.sql`
      SELECT key, org_id::text AS org_id, bytes, created_at
        FROM storage_object WHERE key = ANY(${keys}::text[]) AND deleted_at IS NULL`);
    for (const r of rows) {
      out.set(r.key, { orgId: r.org_id, bytes: Number(r.bytes), createdAt: r.created_at });
    }
    return out;
  }

  /** Every org that has a totals row or a live object row. */
  async orgsWithUsage(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ org_id: string }>>(Prisma.sql`
      SELECT org_id::text AS org_id FROM org_storage_usage
      UNION
      SELECT DISTINCT org_id::text FROM storage_object WHERE deleted_at IS NULL`);
    return rows.map((r) => r.org_id);
  }

  /**
   * Live rows of one org created before `before`, a page at a time,
   * ordered by key. The reconcile walks these to find rows whose
   * object is gone.
   */
  async liveKeysOfOrg(
    orgId: string,
    before: Date,
    afterKey: string,
    limit: number,
  ): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ key: string }>>(Prisma.sql`
      SELECT key FROM storage_object
       WHERE org_id = ${orgId}::uuid AND deleted_at IS NULL
         AND created_at < ${before} AND key > ${afterKey}
       ORDER BY key
       LIMIT ${limit}`);
    return rows.map((r) => r.key);
  }
}

async function recordInTx(tx: Tx, e: LedgerEntry & { bytes: number }, log: Logger): Promise<number> {
  const bytes = BigInt(e.bytes);
  const inserted = await tx.$queryRaw<Array<{ bytes: bigint }>>(Prisma.sql`
    INSERT INTO storage_object (key, org_id, kind, bytes, item_id)
    VALUES (${e.key}, ${e.orgId}::uuid, ${e.kind}, ${bytes}, ${e.itemId ?? null}::uuid)
    ON CONFLICT (key) DO NOTHING
    RETURNING bytes`);
  if (inserted.length === 1) {
    await addToTotals(tx, e.orgId, bytes, 1n);
    return e.bytes;
  }
  // The row exists. Lock it, read the old values and write the new
  // ones in one statement, filtered by the org so another org's row is
  // never changed.
  const updated = await tx.$queryRaw<Array<{ old_bytes: bigint; was_deleted: boolean }>>(Prisma.sql`
    UPDATE storage_object s
       SET bytes = ${bytes}, deleted_at = NULL,
           item_id = COALESCE(${e.itemId ?? null}::uuid, s.item_id)
      FROM (SELECT key, bytes, deleted_at FROM storage_object
             WHERE key = ${e.key} AND org_id = ${e.orgId}::uuid FOR UPDATE) old
     WHERE s.key = old.key
    RETURNING old.bytes AS old_bytes, old.deleted_at IS NOT NULL AS was_deleted`);
  const prev = updated[0];
  if (!prev) {
    log.warn(`Ledger: ${e.key} is recorded for another organization; left unchanged`);
    return 0;
  }
  const delta = prev.was_deleted ? bytes : bytes - prev.old_bytes;
  const objects = prev.was_deleted ? 1n : 0n;
  if (delta !== 0n || objects !== 0n) await addToTotals(tx, e.orgId, delta, objects);
  return Number(delta);
}

async function markDeletedInTx(tx: Tx, key: string, orgId?: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ org_id: string; bytes: bigint }>>(
    orgId === undefined
      ? Prisma.sql`
          UPDATE storage_object SET deleted_at = now()
           WHERE key = ${key} AND deleted_at IS NULL
          RETURNING org_id::text AS org_id, bytes`
      : Prisma.sql`
          UPDATE storage_object SET deleted_at = now()
           WHERE key = ${key} AND org_id = ${orgId}::uuid AND deleted_at IS NULL
          RETURNING org_id::text AS org_id, bytes`,
  );
  const row = rows[0];
  if (!row) return 0;
  await addToTotals(tx, row.org_id, -row.bytes, -1n);
  return -Number(row.bytes);
}

async function addToTotals(tx: Tx, orgId: string, bytes: bigint, objects: bigint): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO org_storage_usage (org_id, bytes, objects, updated_at)
    VALUES (${orgId}::uuid, ${bytes}, ${objects}, now())
    ON CONFLICT (org_id) DO UPDATE
      SET bytes = org_storage_usage.bytes + EXCLUDED.bytes,
          objects = org_storage_usage.objects + EXCLUDED.objects,
          updated_at = now()`);
}
