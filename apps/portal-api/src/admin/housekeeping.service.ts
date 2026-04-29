import { statfs } from 'node:fs/promises';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ItemType } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import { itemBbox } from '../items/item-bbox.js';
import {
  V3TablesService,
  type V3LayerShape,
} from '../features-v3/v3-tables.service.js';
import {
  CredentialService,
  type CredentialPayload,
} from '../items/credential.service.js';
import { exchangeBasicForArcgisToken } from '../items/arcgis-auth.js';
import { probeArcgisExtent } from '../items/arcgis-extent.js';
import {
  extractDependencies,
  normalizeArcgisUrl,
} from '../items/dependency-extractor.js';
import { StorageService } from '../storage/storage.service.js';

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
  private readonly log = new Logger(HousekeepingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: ConfigService,
    private readonly v3Tables: V3TablesService,
    private readonly credentials: CredentialService,
    private readonly storage: StorageService,
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
   * Items the admin might consider retiring. Heuristic: effective
   * "last activity" older than `staleItemDays` AND zero shares
   * (nobody else cares about this item). For data_layers, effective
   * activity is MAX(item.updatedAt, latest feature edit in the v3
   * layer tables): a layer that's been actively receiving features
   * is fresh even if nobody touched the item card (#95).
   *
   * Dependency tracking in GratisGIS is computed on the fly from
   * `item.data` rather than stored in a table, so we don't fold
   * "is anyone depending on this" into the query: the admin should
   * glance at the item detail page before deleting.
   */
  async staleItems(orgId: string) {
    const cutoff = new Date(
      Date.now() - this.staleItemDays * 24 * 60 * 60 * 1000,
    );
    // Pull a generous candidate set by item.updatedAt only; the
    // refine step below drops data_layers whose underlying feature
    // tables have recent activity. Multiplier keeps the displayed
    // topN populated even when many candidates get filtered out.
    const candidates = await this.prisma.item.findMany({
      where: {
        orgId,
        deletedAt: null,
        updatedAt: { lt: cutoff },
        // Items recently accessed via the proxy can't be stale by
        // definition; filter them out at the SQL layer so we don't
        // pay the per-item refine cost. NULL lastUsageAt passes
        // through (means "never touched via proxy" -- no signal
        // either way; the refinement step below handles it).
        OR: [
          { lastUsageAt: null },
          { lastUsageAt: { lt: cutoff } },
        ],
        shares: { none: {} },
      },
      select: {
        id: true,
        title: true,
        type: true,
        data: true,
        updatedAt: true,
        lastUsageAt: true,
        ownerId: true,
        access: true,
        owner: { select: { username: true, fullName: true } },
      },
      orderBy: { updatedAt: 'asc' },
      take: this.topN * 5,
    });
    // Referential freshness (#98, conservative version): an item
    // referenced by any non-trashed item in the org isn't stale,
    // even if its own activity signals are quiet. A pick_list used
    // by an active data_layer, a basemap embedded in an active map,
    // an arcgis_service referenced by a map's layer URL -- all stay
    // fresh because something depends on them. Built once per
    // staleItems() call; the per-candidate lookup is just a Set.has.
    const referenced = await this.buildReferencedItemSet(orgId);
    const refined: Array<
      (typeof candidates)[number] & { effectiveActivity: Date }
    > = [];
    for (const r of candidates) {
      if (referenced.has(r.id)) continue;
      const dataAt = await this.dataActivityAt(r.id, r.type, r.data);
      const effective = pickEffectiveActivity(
        r.updatedAt,
        dataAt,
        r.lastUsageAt,
      );
      if (effective < cutoff) {
        refined.push({ ...r, effectiveActivity: effective });
      }
    }
    refined.sort(
      (a, b) =>
        a.effectiveActivity.getTime() - b.effectiveActivity.getTime(),
    );
    return refined.slice(0, this.topN).map((r) => {
      const dataAt = null; // already folded into effectiveActivity
      void dataAt;
      const source = whichActivity(
        r.updatedAt,
        // re-derive: not stored on the row, but
        // effectiveActivity matches one of these by construction
        r.lastUsageAt,
        r.effectiveActivity,
      );
      return {
        id: r.id,
        title: r.title,
        type: r.type,
        access: r.access,
        updatedAt: r.updatedAt.toISOString(),
        // Effective activity is what drives the staleness call. The
        // source label tells the admin which signal won so they
        // know whether it was item edits, feature edits, or live
        // user requests.
        lastActivityAt: r.effectiveActivity.toISOString(),
        lastActivitySource: source,
        ownerId: r.ownerId,
        ownerLabel:
          r.owner?.fullName?.trim() ||
          r.owner?.username ||
          r.ownerId.slice(0, 8),
      };
    });
  }

  /**
   * Most recent activity timestamp for an item that's relevant to
   * the stale heuristic (#95). For v3 data_layers, queries the
   * feature tables for max edited_at / valid_to. For other types,
   * returns null (the caller falls back to item.updatedAt).
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
    // Two passes. First, the JSON metadata size of every item (cheap;
    // single-statement scan). Second, for v3 data_layer items, the
    // sum of pg_total_relation_size over each item's per-layer
    // feature tables (`fs_<itemIdNoDashes>_*`). Adding those gives
    // total backend footprint, not just metadata. Form submissions
    // and file attachments aren't attributed back to their owning
    // item here -- those show up under the "Largest database tables"
    // card (form_submission table) and are tracked separately on the
    // MinIO usage row. Mixing them in here would require either a
    // join keyed on form_id (different unit) or an N+1 walk into
    // MinIO (slow). The follow-up to track per-item sizeBytes on
    // upload would close those gaps.
    type RawRow = {
      id: string;
      title: string;
      type: string;
      owner_id: string;
      owner_label: string | null;
      metadata_bytes: bigint;
      data_bytes: bigint | null;
      updated_at: Date;
    };
    const rows = await this.prisma.$queryRaw<RawRow[]>`
      WITH meta AS (
        SELECT
          i.id,
          i.title,
          i.type,
          i.owner_id,
          COALESCE(NULLIF(u.full_name, ''), u.username) AS owner_label,
          octet_length(i.data_json::text)::bigint AS metadata_bytes,
          i.updated_at
        FROM "item" i
        LEFT JOIN "user" u ON u.id = i.owner_id
        WHERE i.org_id = ${orgId}::uuid
          AND i.deleted_at IS NULL
      ),
      data_sizes AS (
        SELECT
          (REPLACE(SUBSTRING(c.relname FROM 4 FOR 32), '_', '-')) AS item_id_compact,
          SUM(pg_total_relation_size(c.oid))::bigint AS bytes
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname LIKE 'fs\_%' ESCAPE '\'
        GROUP BY 1
      )
      SELECT
        m.id,
        m.title,
        m.type,
        m.owner_id,
        m.owner_label,
        m.metadata_bytes,
        d.bytes AS data_bytes,
        m.updated_at
      FROM meta m
      LEFT JOIN data_sizes d
        ON d.item_id_compact = REPLACE(m.id::text, '-', '')
      ORDER BY (m.metadata_bytes + COALESCE(d.bytes, 0)) DESC
      LIMIT ${this.topN}
    `;
    return rows.map((r) => {
      const metadataBytes = Number(r.metadata_bytes);
      const dataBytes = r.data_bytes == null ? 0 : Number(r.data_bytes);
      return {
        id: r.id,
        title: r.title,
        type: r.type as string,
        ownerId: r.owner_id,
        ownerLabel: r.owner_label ?? r.owner_id.slice(0, 8),
        // Total = metadata JSON + (for data_layer) feature-table footprint.
        sizeBytes: metadataBytes + dataBytes,
        metadataBytes,
        // dataBytes is set only for items whose feature tables we
        // can attribute back via the fs_<itemId>_* naming pattern --
        // i.e. v3 data_layer items. 0 for everything else.
        dataBytes,
        updatedAt: r.updated_at.toISOString(),
      };
    });
  }

  /**
   * High-level storage telemetry surfaced on the Housekeeping page
   * (#161). Three sources stitched together so the operator can
   * answer "are we running low on disk" in one glance:
   *
   *   - postgres: total database size (pg_database_size). The
   *                bulk of GratisGIS data lives here -- feature
   *                tables, form submissions, item metadata.
   *   - minio:    object count + bytes across the configured
   *                bucket. Thumbnails, hero images, avatars,
   *                feature attachments. Computed by walking
   *                ListObjectsV2; null if MinIO isn't reachable.
   *   - host:     free / total bytes on the volume the API
   *                process is running on (statfs over '/'). On
   *                a docker-compose deployment this is the same
   *                volume as the postgres data dir for most
   *                operators, so it's the right "are we full"
   *                signal even though it's not an exact match.
   *                Returns null on unsupported platforms.
   *
   * All values are cheap to compute except the bucket walk, which
   * is O(N objects). The caller (HousekeepingController.storage)
   * is expected to be hit on demand -- not on every page render --
   * so a few hundred ms on a large bucket is fine.
   */
  async storageMetrics() {
    const [dbSize, hostDisk, bucket] = await Promise.all([
      this.queryDatabaseSize(),
      this.queryHostDisk(),
      this.storage.getBucketUsage(),
    ]);
    return {
      postgres: {
        databaseName: dbSize.databaseName,
        totalBytes: dbSize.totalBytes,
      },
      minio: bucket
        ? {
            bucket: this.storage.bucketName,
            objectCount: bucket.objectCount,
            totalBytes: bucket.totalBytes,
            unavailable: false,
          }
        : {
            bucket: this.storage.bucketName,
            objectCount: 0,
            totalBytes: 0,
            unavailable: true,
          },
      host: hostDisk,
    };
  }

  /**
   * Top N database tables by total relation size (heap + indexes +
   * TOAST). Useful when one feature table is bloating the cluster
   * and the operator wants to know which one. Joins to pg_stat_user_tables
   * for live row-count estimates. Limited to public-schema regular
   * tables so we skip toast/index/sequence noise.
   */
  async largestTables() {
    type Row = {
      schema: string;
      name: string;
      total_bytes: bigint;
      table_bytes: bigint;
      index_bytes: bigint;
      row_estimate: number | null;
    };
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT
        n.nspname AS schema,
        c.relname AS name,
        pg_total_relation_size(c.oid)::bigint AS total_bytes,
        pg_relation_size(c.oid)::bigint AS table_bytes,
        (pg_total_relation_size(c.oid) - pg_relation_size(c.oid))::bigint
          AS index_bytes,
        c.reltuples::float8::int AS row_estimate
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
      ORDER BY pg_total_relation_size(c.oid) DESC
      LIMIT 10
    `;
    return rows.map((r) => ({
      schema: r.schema,
      name: r.name,
      totalBytes: Number(r.total_bytes),
      tableBytes: Number(r.table_bytes),
      indexBytes: Number(r.index_bytes),
      rowEstimate: r.row_estimate ?? 0,
    }));
  }

  /**
   * Total bytes used by the current Postgres database. Includes
   * heap, indexes, TOAST, and per-relation FSM. Cheap (O(1) catalog
   * lookup); safe to call on every Housekeeping page render.
   */
  private async queryDatabaseSize(): Promise<{
    databaseName: string;
    totalBytes: number;
  }> {
    const rows = await this.prisma.$queryRaw<
      Array<{ db: string; size: bigint }>
    >`
      SELECT
        current_database() AS db,
        pg_database_size(current_database())::bigint AS size
    `;
    const r = rows[0];
    return {
      databaseName: r?.db ?? 'unknown',
      totalBytes: r ? Number(r.size) : 0,
    };
  }

  /**
   * Free / total bytes on the volume hosting the API process.
   * Returns null when statfs isn't supported (older Node, exotic
   * platform): the UI hides the disk gauge in that case rather
   * than guessing.
   */
  private async queryHostDisk(): Promise<{
    mountPoint: string;
    totalBytes: number;
    freeBytes: number;
  } | null> {
    // We probe the filesystem the API process is on. On a typical
    // single-host docker-compose deployment, the postgres data
    // volume and the MinIO data volume both live on this same
    // disk, so this is a defensible "the box is full" signal.
    // Operators who split data across volumes should replace this
    // with a deployment-specific monitor (#161 follow-up).
    const probePath = process.platform === 'win32' ? 'C:\\' : '/';
    try {
      const s = await statfs(probePath);
      // Node's StatFs reports bsize + blocks + bavail. Multiply for
      // bytes. bavail (not bfree) is what's available to a non-root
      // user; that's the right "we can write more" number.
      const totalBytes = Number(BigInt(s.bsize) * BigInt(s.blocks));
      const freeBytes = Number(BigInt(s.bsize) * BigInt(s.bavail));
      return { mountPoint: probePath, totalBytes, freeBytes };
    } catch (err) {
      this.log.warn(
        `Disk metrics unavailable: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
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
    // Refine the count the same way staleItems() does so the
    // headline number matches the list. Doing the data-activity
    // probe per candidate is cheap because the cheap SQL filter
    // already narrowed to "no shares + old item.updatedAt + no
    // recent proxy usage".
    const candidates = await this.prisma.item.findMany({
      where: {
        orgId,
        deletedAt: null,
        updatedAt: { lt: cutoff },
        OR: [{ lastUsageAt: null }, { lastUsageAt: { lt: cutoff } }],
        shares: { none: {} },
      },
      select: {
        id: true,
        type: true,
        data: true,
        updatedAt: true,
        lastUsageAt: true,
      },
    });
    const referenced = await this.buildReferencedItemSet(orgId);
    let n = 0;
    for (const c of candidates) {
      if (referenced.has(c.id)) continue;
      const dataAt = await this.dataActivityAt(c.id, c.type, c.data);
      const effective = pickEffectiveActivity(
        c.updatedAt,
        dataAt,
        c.lastUsageAt,
      );
      if (effective < cutoff) n += 1;
    }
    return n;
  }

  /**
   * Reverse index of "what items are referenced by other items"
   * (#98). Walks every non-trashed item's data, runs the existing
   * extractDependencies() helper, and gathers the union of all
   * referenced item ids. URL references (arcgis-rest layer URLs in
   * a map pointing at an arcgis_service item) are resolved here too:
   * the arcgis_service item is added when its data.url normalises
   * to a URL key that any other item references. The resulting Set
   * is consulted by the stale heuristic; an item id present in the
   * set is treated as fresh regardless of its own activity signals,
   * because something else in the org depends on it.
   */
  async buildReferencedItemSet(orgId: string): Promise<Set<string>> {
    const rows = await this.prisma.item.findMany({
      where: { orgId, deletedAt: null },
      select: { id: true, type: true, data: true },
    });
    const referencedIds = new Set<string>();
    const referencedUrlKeys = new Set<string>();
    for (const r of rows) {
      const deps = extractDependencies({ type: r.type, data: r.data });
      for (const id of deps.itemIds) referencedIds.add(id);
      for (const u of deps.urls) referencedUrlKeys.add(u);
    }
    if (referencedUrlKeys.size > 0) {
      // Resolve URL refs to arcgis_service item ids: any service
      // whose data.url matches a referenced URL key is treated as
      // depended-on. Cheap because the typical org has a handful
      // of arcgis_service items.
      const services = await this.prisma.item.findMany({
        where: {
          orgId,
          deletedAt: null,
          type: {
            in: ['arcgis_service', 'wms_service', 'wfs_service'],
          },
        },
        select: { id: true, data: true },
      });
      for (const s of services) {
        const rawUrl = (s.data as { url?: unknown } | null)?.url;
        if (typeof rawUrl !== 'string' || rawUrl.length === 0) continue;
        const key = normalizeArcgisUrl(rawUrl);
        if (referencedUrlKeys.has(key)) referencedIds.add(s.id);
      }
    }
    return referencedIds;
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
        // Fall back paths in priority order:
        //   1) the raw stored data.bbox / data.layers[].bbox
        //   2) walk inline features (v1 data_layers carry their
        //      GeoJSON FeatureCollection at data.data; itemBbox()
        //      doesn't peer into features so we do it here)
        // The walk only kicks in when there's no cached extent yet,
        // so a single recompute is enough to seed older fixtures
        // and per-feature edits will keep it fresh once we wire
        // post-CRUD recompute hooks.
        if (!next) next = itemBbox(it.type, it.data);
        if (!next) next = walkInlineFeatureBbox(it.data);
      } else if (it.type === 'map') {
        // Aggregate from referenced items' freshly-recomputed bboxes.
        const refs = collectMapItemRefs(it.data);
        if (refs.length > 0) {
          next = await this.aggregateFromReferenced(refs, freshById);
        }
        if (!next) next = itemBbox(it.type, it.data);
      } else if (it.type === 'arcgis_service') {
        // Probe the upstream for the actual feature extent of every
        // sublayer. Cheaper than the proxy for our purposes since
        // we only need the envelope, not the features. Falls back
        // to whatever's in data.bbox if the probe yields nothing
        // (network error, all sublayers empty, etc).
        next = await this.probeArcgisServiceBbox(it.id, it.data);
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
   * Probe the upstream ArcGIS service for true feature extent
   * (#94). Walks data.layers[] and asks each sublayer for its
   * returnExtentOnly response, aggregates the envelopes, and
   * returns the result in EPSG:4326. Honors data.requiresAuth via
   * CredentialService + arcgis-token exchange so secured services
   * work the same as the live proxy. Failures (network, auth,
   * single-layer 500) are non-fatal -- we log and let the recompute
   * fall back to data.bbox.
   */
  private async probeArcgisServiceBbox(
    itemId: string,
    data: unknown,
  ): Promise<[number, number, number, number] | null> {
    if (!data || typeof data !== 'object') return null;
    const d = data as {
      url?: unknown;
      requiresAuth?: unknown;
      layers?: unknown;
    };
    const url = typeof d.url === 'string' ? d.url : null;
    if (!url) return null;
    const layerIds = collectArcgisLayerIds(d.layers);
    if (layerIds.length === 0) return null;

    let credential: CredentialPayload | null = null;
    if (d.requiresAuth === true) {
      try {
        credential = await this.credentials.getCredentialForProxy(itemId);
      } catch (err) {
        // Without the credential we can't reach a secured service.
        // Log and bail; the fallback path will keep whatever
        // data.bbox already had.
        this.log.warn(
          `arcgis extent probe: no credential for item=${itemId}: ${
            err instanceof Error ? err.message : err
          }`,
        );
        return null;
      }
      // Mirror the proxy controller: ArcGIS REST won't honor HTTP
      // Basic on data endpoints (#76), so exchange basic creds for
      // a token before probing.
      if (credential.kind === 'basic' && /\/arcgis\/rest\//i.test(url)) {
        try {
          const token = await exchangeBasicForArcgisToken({
            serviceUrl: url,
            username: credential.username,
            password: credential.password,
            cacheKey: itemId,
          });
          credential = { kind: 'arcgis_token', token };
        } catch (err) {
          this.log.warn(
            `arcgis extent probe: token exchange failed for item=${itemId}: ${
              err instanceof Error ? err.message : err
            }`,
          );
          return null;
        }
      }
    }
    return probeArcgisExtent(url, layerIds, credential, {
      warn: (msg) => this.log.warn(`arcgis extent (${itemId}): ${msg}`),
    });
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

/**
 * Combine the three freshness signals an item carries (#95, #96)
 * into a single effective activity timestamp. Each signal can be
 * null when the item type doesn't produce one (e.g. arcgis_service
 * has no underlying feature edits; basemap items are never proxied
 * so lastUsageAt stays null). Picks whichever is most recent.
 */
function pickEffectiveActivity(
  updatedAt: Date,
  dataAt: Date | null,
  usageAt: Date | null,
): Date {
  let max = updatedAt;
  if (dataAt && dataAt > max) max = dataAt;
  if (usageAt && usageAt > max) max = usageAt;
  return max;
}

/**
 * Which signal won the freshness race? Used purely for UI labels
 * so the admin can tell what's keeping an item alive.
 */
function whichActivity(
  updatedAt: Date,
  usageAt: Date | null,
  effective: Date,
): 'item' | 'data' | 'usage' {
  if (usageAt && usageAt.getTime() === effective.getTime()) return 'usage';
  if (effective.getTime() === updatedAt.getTime()) return 'item';
  return 'data';
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

/** v1 data_layer fallback: peer into the inline FeatureCollection
 *  at data.data and compute the envelope of every feature's
 *  geometry. itemBbox() only reads data.bbox, so this catches the
 *  case where a v1 layer has features but the cached bbox was
 *  never populated. Walks Multi* geometries via their flattened
 *  coordinate arrays; ignores GeometryCollection (rare in this
 *  shape) to keep the helper small. */
function walkInlineFeatureBbox(
  data: unknown,
): [number, number, number, number] | null {
  if (!data || typeof data !== 'object') return null;
  const inner = (data as { data?: unknown }).data;
  if (!inner || typeof inner !== 'object') return null;
  const fc = inner as { type?: unknown; features?: unknown };
  if (fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    return null;
  }
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  let any = false;
  const visit = (xy: unknown) => {
    if (
      Array.isArray(xy) &&
      xy.length >= 2 &&
      typeof xy[0] === 'number' &&
      typeof xy[1] === 'number'
    ) {
      w = Math.min(w, xy[0]);
      e = Math.max(e, xy[0]);
      s = Math.min(s, xy[1]);
      n = Math.max(n, xy[1]);
      any = true;
    }
  };
  const walk = (coords: unknown) => {
    if (!Array.isArray(coords)) return;
    if (
      coords.length > 0 &&
      typeof coords[0] === 'number' &&
      typeof coords[1] === 'number'
    ) {
      visit(coords);
      return;
    }
    for (const c of coords) walk(c);
  };
  for (const f of fc.features as Array<{ geometry?: unknown }>) {
    const g = f?.geometry as { type?: unknown; coordinates?: unknown } | null;
    if (!g || typeof g !== 'object') continue;
    walk(g.coordinates);
  }
  return any ? [w, s, e, n] : null;
}

/** Read the numeric layer ids from an arcgis_service item's
 *  data.layers[]. Probed by the wizard at create time and persisted
 *  there so we don't have to round-trip the service root again
 *  during recompute. */
function collectArcgisLayerIds(layersData: unknown): number[] {
  if (!Array.isArray(layersData)) return [];
  const out: number[] = [];
  for (const l of layersData) {
    if (!l || typeof l !== 'object') continue;
    const id = (l as { id?: unknown }).id;
    if (typeof id === 'number' && Number.isFinite(id)) out.push(id);
    else if (typeof id === 'string' && /^\d+$/.test(id)) out.push(Number(id));
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
