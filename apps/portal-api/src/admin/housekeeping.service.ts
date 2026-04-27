import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ItemType } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import { itemBbox } from '../items/item-bbox.js';
import {
  V3TablesService,
  type V3LayerShape,
} from '../features-v3/v3-tables.service.js';

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
    private readonly v3Tables: V3TablesService,
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
  /**
   * Default lookahead window for the "soon to expire" panels (#86).
   * Override per-request with the `?within=` query parameter when
   * the admin wants a wider or narrower view.
   */
  private static readonly DEFAULT_EXPIRY_WINDOW_DAYS = 30;

  async summary(orgId: string) {
    const [stale, users, totalItems, totalUsers, expShares, expUsers] =
      await Promise.all([
        this.countStaleItems(orgId),
        this.countStaleUsers(orgId),
        this.prisma.item.count({ where: { orgId, deletedAt: null } }),
        this.prisma.user.count({ where: { orgId } }),
        this.countExpiringShares(orgId, HousekeepingService.DEFAULT_EXPIRY_WINDOW_DAYS),
        this.countExpiringUsers(orgId, HousekeepingService.DEFAULT_EXPIRY_WINDOW_DAYS),
      ]);
    return {
      staleItemDays: this.staleItemDays,
      staleUserDays: this.staleUserDays,
      staleItemCount: stale,
      staleUserCount: users,
      totalItemCount: totalItems,
      totalUserCount: totalUsers,
      // "Soon to expire" counts (#86): inside the default window OR
      // already past. Drives the warning chips on the summary strip;
      // detail lists are returned by the dedicated endpoints below
      // so this stays cheap.
      expiryWindowDays: HousekeepingService.DEFAULT_EXPIRY_WINDOW_DAYS,
      expiringShareCount: expShares,
      expiringUserCount: expUsers,
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

  /**
   * Item shares with a non-null `expires_at` that lands in the
   * "soon" bucket: anything from already-expired through `withinDays`
   * out. Sorted soonest first so the admin can deal with imminent
   * cutoffs ahead of routine 30-day-out reminders. Includes the
   * item title and recipient label so the panel renders without
   * a follow-up lookup per row.
   *
   * The recipient label is denormalised at query time: principalId
   * is a UUID that points either at a user (principalType='user')
   * or a group (principalType='group'), and we want a single column
   * the UI can render without branching. Falls back to a short id
   * when the join misses (the principal was deleted out from under
   * the share).
   */
  async expiringShares(orgId: string, withinDays: number) {
    const horizon = new Date(Date.now() + withinDays * 24 * 60 * 60 * 1000);
    const rows = await this.prisma.$queryRaw<
      Array<{
        item_id: string;
        item_title: string;
        item_type: string;
        principal_type: 'user' | 'group';
        principal_id: string;
        principal_label: string | null;
        permission: string;
        expires_at: Date;
      }>
    >`
      SELECT
        s.item_id,
        i.title           AS item_title,
        i.type            AS item_type,
        s.principal_type::text AS principal_type,
        s.principal_id,
        CASE s.principal_type
          WHEN 'user'  THEN COALESCE(NULLIF(u.full_name, ''), u.username)
          WHEN 'group' THEN g.title
        END AS principal_label,
        s.permission::text AS permission,
        s.expires_at
      FROM "item_share" s
      JOIN "item" i ON i.id = s.item_id
      LEFT JOIN "user"  u ON s.principal_type = 'user'  AND u.id = s.principal_id
      LEFT JOIN "group" g ON s.principal_type = 'group' AND g.id = s.principal_id
      WHERE i.org_id = ${orgId}::uuid
        AND i.deleted_at IS NULL
        AND s.expires_at IS NOT NULL
        AND s.expires_at <= ${horizon}
      ORDER BY s.expires_at ASC
      LIMIT ${this.topN}
    `;
    return rows.map((r) => ({
      itemId: r.item_id,
      itemTitle: r.item_title,
      itemType: r.item_type,
      principalType: r.principal_type,
      principalId: r.principal_id,
      principalLabel: r.principal_label ?? r.principal_id.slice(0, 8),
      permission: r.permission,
      expiresAt: r.expires_at.toISOString(),
      isExpired: r.expires_at.getTime() <= Date.now(),
    }));
  }

  /**
   * Users with an explicit auto_disable_at set. Admins are never in
   * this list (the admin form refuses to set one; auth-sync ignores
   * it on admins as a defence in depth) but we still filter here so
   * a stray DB row can't surface and confuse the UI.
   */
  async expiringUsers(orgId: string, withinDays: number) {
    const horizon = new Date(Date.now() + withinDays * 24 * 60 * 60 * 1000);
    const rows = await this.prisma.user.findMany({
      where: {
        orgId,
        orgRole: { not: 'admin' },
        autoDisableAt: { not: null, lte: horizon },
      },
      select: {
        id: true,
        username: true,
        fullName: true,
        email: true,
        orgRole: true,
        autoDisableAt: true,
        lastSeenAt: true,
        _count: { select: { ownedItems: true } },
      },
      orderBy: { autoDisableAt: 'asc' },
      take: this.topN,
    });
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      fullName: r.fullName,
      email: r.email,
      orgRole: r.orgRole,
      autoDisableAt: r.autoDisableAt!.toISOString(),
      lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
      ownedItemCount: r._count.ownedItems,
      isExpired: r.autoDisableAt!.getTime() <= Date.now(),
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

  private async countExpiringShares(
    orgId: string,
    withinDays: number,
  ): Promise<number> {
    const horizon = new Date(Date.now() + withinDays * 24 * 60 * 60 * 1000);
    return this.prisma.itemShare.count({
      where: {
        item: { orgId, deletedAt: null },
        expiresAt: { not: null, lte: horizon },
      },
    });
  }

  private async countExpiringUsers(
    orgId: string,
    withinDays: number,
  ): Promise<number> {
    const horizon = new Date(Date.now() + withinDays * 24 * 60 * 60 * 1000);
    return this.prisma.user.count({
      where: {
        orgId,
        orgRole: { not: 'admin' },
        autoDisableAt: { not: null, lte: horizon },
      },
    });
  }

  /**
   * Recompute item.bbox for every spatial item in the org (#90).
   * Walks data_layers, maps, geo_boundaries, and *_service items
   * and recomputes their cached extent from the most accurate
   * source we can reach without leaving the local DB:
   *
   *   - data_layer (v3): aggregate ST_Extent across the per-layer
   *     PostGIS tables (this is the actual feature footprint, not
   *     whatever was guessed at create time)
   *   - map: aggregate from referenced data_layer / arcgis_service
   *     items' bboxes (after they've been recomputed in the same
   *     pass; we order data_layers first so maps see fresh data)
   *   - geo_boundary, *_service, fallback: itemBbox(type, data)
   *
   * Returns counts so the admin UI can render "X items updated".
   * Skipping the network round-trip to ArcGIS upstreams keeps this
   * fast and predictable; admins can re-probe individual services
   * via the wizard if they need a true feature extent there.
   */
  async recomputeExtents(orgId: string): Promise<{
    scanned: number;
    updated: number;
    perType: Record<string, number>;
  }> {
    const items = await this.prisma.item.findMany({
      where: {
        orgId,
        deletedAt: null,
        type: {
          in: [
            'data_layer',
            'map',
            'arcgis_service',
            'wms_service',
            'wfs_service',
            'geo_boundary',
          ],
        },
      },
      select: { id: true, type: true, data: true },
    });
    // Recompute data_layer / boundary / service extents first so the
    // map pass below sees the freshest referenced bboxes when it
    // aggregates. Maps come last.
    const ordered = [...items].sort((a, b) => typeOrder(a.type) - typeOrder(b.type));

    const perType: Record<string, number> = {};
    let updated = 0;
    // Cache of just-recomputed bboxes keyed by item id; lets the
    // map pass aggregate from the freshly-stored values without
    // re-reading the row from the DB.
    const freshById = new Map<string, [number, number, number, number] | null>();

    for (const it of ordered) {
      let next: [number, number, number, number] | null = null;
      if (it.type === 'data_layer') {
        const layers = readV3Layers(it.data);
        if (layers !== null) {
          next = await this.v3Tables.aggregateBbox(it.id, layers);
        }
        // Fall back to whatever data.bbox / data.layers[].bbox carries
        // when the v3 tables yield nothing (legacy v1/v2, or a v3
        // layer with no spatial features yet).
        if (!next) next = itemBbox(it.type, it.data);
      } else if (it.type === 'map') {
        // Aggregate from referenced items' freshly-recomputed bboxes.
        const refs = collectMapItemRefs(it.data);
        if (refs.length > 0) {
          next = await this.aggregateFromReferenced(refs, freshById);
        }
        if (!next) next = itemBbox(it.type, it.data);
      } else {
        next = itemBbox(it.type, it.data);
      }
      freshById.set(it.id, next);

      // Skip the write when the value didn't change (saves a write
      // amplification round on every recompute even when nothing
      // moved). Compare element-by-element since [] !== [] in JS.
      const existing = await this.prisma.item.findUnique({
        where: { id: it.id },
        select: { bbox: true },
      });
      if (bboxEqual(existing?.bbox as number[] | null | undefined, next)) {
        continue;
      }
      await this.prisma.item.update({
        where: { id: it.id },
        data: { bbox: next ?? [] },
      });
      updated += 1;
      perType[it.type] = (perType[it.type] ?? 0) + 1;
    }
    return { scanned: items.length, updated, perType };
  }

  /**
   * Aggregate bboxes from a list of referenced item ids (used by
   * the map pass). Reads from the in-memory freshById cache when
   * present, falls back to the DB row when the map references an
   * item we didn't recompute (different org, deleted, etc.).
   */
  private async aggregateFromReferenced(
    refs: string[],
    freshById: Map<string, [number, number, number, number] | null>,
  ): Promise<[number, number, number, number] | null> {
    let w = Infinity;
    let s = Infinity;
    let e = -Infinity;
    let n = -Infinity;
    let any = false;
    const missing: string[] = [];
    for (const id of refs) {
      const cached = freshById.has(id) ? freshById.get(id) : undefined;
      if (cached === undefined) {
        missing.push(id);
        continue;
      }
      if (!cached) continue;
      w = Math.min(w, cached[0]);
      s = Math.min(s, cached[1]);
      e = Math.max(e, cached[2]);
      n = Math.max(n, cached[3]);
      any = true;
    }
    if (missing.length > 0) {
      const rows = await this.prisma.item.findMany({
        where: { id: { in: missing }, deletedAt: null },
        select: { bbox: true },
      });
      for (const row of rows) {
        const b = row.bbox as number[] | null;
        if (Array.isArray(b) && b.length === 4) {
          w = Math.min(w, b[0]!);
          s = Math.min(s, b[1]!);
          e = Math.max(e, b[2]!);
          n = Math.max(n, b[3]!);
          any = true;
        }
      }
    }
    return any ? [w, s, e, n] : null;
  }
}

/** Ordering for the recompute pass: deepest dependencies first. */
function typeOrder(t: ItemType): number {
  if (t === 'map') return 99; // last, depends on others
  return 0;
}

/** Whether two stored bbox values are equivalent. Treat null and
 *  the empty-array sentinel as equal (both = "no extent"). */
function bboxEqual(
  a: number[] | null | undefined,
  b: [number, number, number, number] | null,
): boolean {
  const aHas = Array.isArray(a) && a.length === 4;
  const bHas = b !== null;
  if (!aHas && !bHas) return true;
  if (!aHas || !bHas) return false;
  return (
    a![0] === b![0] && a![1] === b![1] && a![2] === b![2] && a![3] === b![3]
  );
}

/** Lightweight shape probe for v3 layers without pulling
 *  ItemsService here (would create a DI cycle). Mirrors the
 *  behaviour of items.service.readV3Layers for the fields we
 *  actually need. */
function readV3Layers(data: unknown): V3LayerShape[] | null {
  if (!data || typeof data !== 'object') return null;
  const v = (data as { version?: unknown; layers?: unknown }).version;
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

/** Walk a map's data.layers[] and return the underlying portal item
 *  ids the layers reference (data_layer source.itemId, plus
 *  arcgis-rest source.sourceItemId when set). Other source kinds
 *  contribute no portal-stored bbox. */
function collectMapItemRefs(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const layers = (data as { layers?: unknown }).layers;
  if (!Array.isArray(layers)) return [];
  const out = new Set<string>();
  for (const l of layers) {
    if (!l || typeof l !== 'object') continue;
    const src = (l as { source?: unknown }).source;
    if (!src || typeof src !== 'object') continue;
    const kind = (src as { kind?: unknown }).kind;
    if (kind === 'data-layer') {
      const id = (src as { itemId?: unknown }).itemId;
      if (typeof id === 'string') out.add(id);
    } else if (kind === 'arcgis-rest') {
      const id = (src as { sourceItemId?: unknown }).sourceItemId;
      if (typeof id === 'string') out.add(id);
    }
  }
  return Array.from(out);
}
