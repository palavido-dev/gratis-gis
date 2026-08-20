// SPDX-License-Identifier: AGPL-3.0-or-later
import { statfs } from 'node:fs/promises';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ItemType } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import { itemBbox } from '../items/item-bbox.js';
import {
  DataLayerTablesService,
  type DataLayerLayerShape,
} from '../data-layer/tables.service.js';
import {
  DataLayerSearchIndexService,
  type SearchIndexBuildResult,
} from '../data-layer/search-index.service.js';
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
import { groupDanglingRefs } from './dangling-refs.js';
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
/**
 * A basemap the portal seeded, rather than one a user added.
 *
 * Basemaps mark themselves with `seededKey` in data_json instead of
 * the `seedKind` column the other catalog types use, so they need
 * their own check. See the staleItems where clause for why seeded
 * content is excluded at all.
 */
function isSeededBasemap(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false;
  const key = (data as { seededKey?: unknown }).seededKey;
  return typeof key === 'string' && key.length > 0;
}

@Injectable()
export class HousekeepingService {
  private readonly log = new Logger(HousekeepingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: ConfigService,
    private readonly dataLayerTables: DataLayerTablesService,
    private readonly searchIndexes: DataLayerSearchIndexService,
    private readonly credentials: CredentialService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Build / reconcile the per-searchable-field trigram indexes for
   * every data_layer in the org (#observation-search-index). Same
   * "walk all items and fix the physical state" family as
   * recomputeExtents below: an explicit admin action rather than a
   * boot-time pass, because index builds on county-scale layers
   * take real time and briefly stall feature writes per index, so
   * an operator should choose the moment. Delegates to
   * DataLayerSearchIndexService; see that service for the DDL and
   * the reasons behind non-concurrent builds.
   */
  async buildSearchIndexes(orgId: string): Promise<SearchIndexBuildResult> {
    return this.searchIndexes.buildForOrg(orgId);
  }

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
    const [stale, users, totalItems, totalUsers, expShares, expUsers, dangling] =
      await Promise.all([
        this.countStaleItems(orgId),
        this.countStaleUsers(orgId),
        this.prisma.item.count({ where: { orgId, deletedAt: null } }),
        this.prisma.user.count({ where: { orgId } }),
        this.countExpiringShares(orgId, HousekeepingService.DEFAULT_EXPIRY_WINDOW_DAYS),
        this.countExpiringUsers(orgId, HousekeepingService.DEFAULT_EXPIRY_WINDOW_DAYS),
        this.danglingReferences(orgId),
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
      // #217 companion: live items referencing item ids that no
      // longer resolve (the silent-broken-layer class).
      danglingReferenceCount: dangling.referrers.length,
    };
  }

  /**
   * #217 companion: live items whose data references item ids that
   * no longer resolve. This is the parcels-incident class: a purged
   * + reseeded item left three maps silently missing their parcels
   * layer, with no error surfaced anywhere. Runs the same
   * extractDependencies walk the dependency panels use (so coverage
   * grows with the extractor), resolves every referenced id in one
   * query, and reports per-referrer rows split into hard-missing
   * (target row gone; repoint or remove the reference) and trashed
   * (recoverable by restoring the target).
   *
   * URL references (arcgis-rest layers pointing at external
   * services) are intentionally out of scope: an external URL has
   * no portal row whose absence would mean breakage.
   */
  async danglingReferences(orgId: string) {
    const rows = await this.prisma.item.findMany({
      where: { orgId, deletedAt: null },
      select: {
        id: true,
        type: true,
        title: true,
        data: true,
        publicGeoBoundaryId: true,
        orgGeoBoundaryId: true,
      },
    });
    const referrers = rows
      .map((r) => ({
        id: r.id,
        type: r.type as string,
        title: r.title,
        refs: extractDependencies(r).itemIds,
      }))
      .filter((r) => r.refs.length > 0);
    const allRefs = [...new Set(referrers.flatMap((r) => r.refs))];
    if (allRefs.length === 0) {
      return { referrers: [] };
    }
    // Deliberately no org filter: a cross-org ref that resolves is
    // not dangling (public items can cross org lines in shared
    // deployments), and a dangling one reports the same either way.
    const found = await this.prisma.item.findMany({
      where: { id: { in: allRefs } },
      select: { id: true, deletedAt: true },
    });
    const liveIds = new Set(
      found.filter((f) => f.deletedAt === null).map((f) => f.id),
    );
    const trashedIds = new Set(
      found.filter((f) => f.deletedAt !== null).map((f) => f.id),
    );
    return { referrers: groupDanglingRefs(referrers, liveIds, trashedIds) };
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
        // Seeded builtins are never stale, however long they sit.
        //
        // Every org gets a catalog at creation: basemaps, themes,
        // print templates, app templates. Most are never edited and
        // most are referenced by nothing, because their job is to be
        // available for someone to pick, not to be used. They
        // therefore satisfy every staleness signal we have, forever.
        //
        // On the demo that was the entire report: twenty stale items,
        // twenty seeded builtins, nothing actionable. A report with a
        // permanent noise floor is a report nobody reads, which costs
        // more than the handful of rows it was hiding.
        //
        // Templates and themes carry `seedKind`; basemaps carry a
        // `seededKey` inside data_json instead, and that one is
        // filtered in the refine loop below rather than here, because
        // a JSON-path predicate is harder to read than one `continue`.
        seedKind: null,
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
      // The basemap half of the seeded-builtin exclusion above.
      if (isSeededBasemap(r.data)) continue;
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
    return this.dataLayerTables.lastDataActivityAt(itemId, layers);
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
          AND c.relname LIKE 'fs\\_%' ESCAPE '\\'
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
   *
   * Excluded by name:
   *   - spatial_ref_sys: PostGIS-managed lookup table, ~7 MB on every
   *     install whether the org has any data or not. Not actionable
   *     to the admin; including it just dominates the chart.
   *   - tables starting with `_` (e.g. `_prisma_migrations`): Prisma
   *     bookkeeping. Same rationale -- not user data.
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
    // #359: explicit ESCAPE clause + a backtick-escaped backslash.
    // The JS template literal flattens `'\_%'` to `'_%'` (since `\_`
    // is not a recognized JS escape), and bare `_` is the LIKE
    // wildcard for "any single char" -- so without this fix the
    // NOT LIKE excluded every non-empty table name and the panel
    // always rendered "No tables to report." Backslash-backslash
    // here yields a single backslash in the SQL string, which the
    // explicit ESCAPE '\\' clause then treats as the escape char so
    // `\_` means literal underscore.
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
        AND c.relname <> 'spatial_ref_sys'
        AND c.relname NOT LIKE '\\_%' ESCAPE '\\'
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
   * Per-data-layer storage breakdown (#115 P10 follow-up).
   *
   * The "Largest database tables" panel above lists raw Postgres
   * relations. After the engine pivot, every layer's features live
   * in the partitioned `observation` table, so that panel just
   * shows a few hot monthly partitions (`observation_p202605xx`)
   * with no visibility into which logical layer is contributing
   * the rows. This method drills down: aggregate observation rows
   * by `scope` (which encodes `data_layer:<itemId>:<layerId>`),
   * join back to `item` for human labels, and return the top N
   * scopes by row count and approximate disk footprint.
   *
   * Bytes are approximate, not literal:
   *   - We compute per-scope row counts via the btree index on
   *     (scope, entity, valid_from DESC), which is cheap. A full
   *     `pg_column_size(observation.*)` per row would require a
   *     seq scan over millions of rows and isn't worth it for an
   *     admin diagnostic.
   *   - We then prorate the total physical size of the observation
   *     partitions across scopes by row count: each scope's
   *     `approx_bytes ≈ scope_rows / total_rows * total_partition_bytes`.
   *     This assumes scopes have roughly comparable row sizes,
   *     which is true for spatial datasets within a layer but not
   *     across radically different schemas. It will undercount
   *     polygon-heavy layers (long EWKT) relative to point layers
   *     within the same item; ranking still holds.
   *
   * The panel labels the bytes column "approx" so the relationship
   * to the heap-level number isn't surprising.
   */
  async largestDataLayers(orgId: string) {
    type ScopeRow = {
      scope: string;
      rows: bigint;
    };
    type SizeRow = {
      total_bytes: bigint;
      total_rows: bigint;
    };

    // Per-scope row counts. WHERE scope LIKE 'data_layer:%' lets the
    // btree on (scope, ...) prefix-match. GROUP BY scope is then
    // a hash aggregate over the matching index entries.
    const scopeRows = await this.prisma.$queryRaw<ScopeRow[]>`
      SELECT scope, COUNT(*)::bigint AS rows
      FROM observation
      WHERE scope LIKE 'data_layer:%'
      GROUP BY scope
      ORDER BY COUNT(*) DESC
      LIMIT 50
    `;

    if (scopeRows.length === 0) return [];

    // Total physical size of every observation partition + the
    // total observation row count, for proration. pg_inherits keys
    // off the parent partitioned-table identity. One round-trip
    // for the whole thing.
    const sizeAgg = await this.prisma.$queryRaw<SizeRow[]>`
      SELECT
        SUM(pg_total_relation_size(inhrelid))::bigint AS total_bytes,
        SUM(COALESCE(s.n_live_tup, 0))::bigint AS total_rows
      FROM pg_inherits i
      LEFT JOIN pg_stat_user_tables s ON s.relid = i.inhrelid
      WHERE i.inhparent = 'observation'::regclass
    `;
    const totalBytes = sizeAgg[0] ? Number(sizeAgg[0].total_bytes) : 0;
    const totalRows = sizeAgg[0] ? Number(sizeAgg[0].total_rows) : 0;

    // Resolve scope -> { itemId, layerId } and join to item for
    // human labels. The scope format is `data_layer:<itemId>:<layerId>`.
    // Some scopes won't have a matching item (orphans from a
    // permanent-deleted item before the cleanup-on-purge fix
    // shipped); surface them as "deleted item" so the user sees
    // exactly how much space the orphans are eating.
    const itemIds = Array.from(
      new Set(
        scopeRows
          .map((r) => parseScope(r.scope)?.itemId)
          .filter((s): s is string => typeof s === 'string'),
      ),
    );
    // Pull `data` alongside the human-facing label so the admin
    // surface can show the sublayer's authored title (e.g.
    // "Parcels") instead of the internal storage key
    // (`lyr_x2ga3naf`). The storage-key fallback still applies
    // when a layer entry is missing, has no label, or the item
    // is a non-v3 shape that never carries `data.layers[]`.
    const items =
      itemIds.length > 0
        ? await this.prisma.item.findMany({
            where: { id: { in: itemIds }, orgId },
            select: { id: true, title: true, type: true, data: true },
          })
        : [];
    const itemById = new Map(items.map((i) => [i.id, i]));

    // Walk `data.layers[]` for each item once so the per-scope
    // resolution below is a Map.get instead of a linear scan.
    // Both `label` (display name) and `name` (machine slug) are
    // valid fall-throughs in that order; we prefer the label
    // because that's what shows up in the legend and layer list.
    const labelByItemAndLayer = new Map<string, Map<string, string>>();
    for (const it of items) {
      const layers = readSublayerLabels(it.data);
      if (layers) labelByItemAndLayer.set(it.id, layers);
    }

    // Filter to scopes whose items belong to the caller's org. An
    // org-admin shouldn't see another tenant's data sizes; a
    // not-in-this-org orphan whose item is gone is shown as
    // "deleted item" because there's no org claim to enforce.
    const out: Array<{
      itemId: string;
      layerId: string;
      itemTitle: string;
      itemType: string | null;
      /**
       * Human-readable layer label sourced from `data.layers[].label`
       * (with fallback to `name`). Null when the item shape doesn't
       * carry sublayer titles (legacy v1/v2) or when the storage key
       * isn't in the item's layer list (e.g. soft-deleted sublayer).
       * The frontend renders `layerTitle ?? layerId` so the column
       * always has something.
       */
      layerTitle: string | null;
      orphan: boolean;
      rows: number;
      approxBytes: number;
    }> = [];
    for (const r of scopeRows) {
      const parsed = parseScope(r.scope);
      if (!parsed) continue;
      const item = itemById.get(parsed.itemId) ?? null;
      const orphan = item === null;
      const rows = Number(r.rows);
      const approxBytes =
        totalRows > 0 ? Math.round((rows / totalRows) * totalBytes) : 0;
      const layerTitle =
        labelByItemAndLayer.get(parsed.itemId)?.get(parsed.layerId) ?? null;
      out.push({
        itemId: parsed.itemId,
        layerId: parsed.layerId,
        itemTitle: item ? item.title : '(deleted item)',
        itemType: item ? item.type : null,
        layerTitle,
        orphan,
        rows,
        approxBytes,
      });
    }
    return out;
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
      select: {
        id: true,
        type: true,
        data: true,
        // #80: tier-level boundary refs count toward "this item is
        // depended on, don't flag it as stale" so a geo_boundary
        // attached as a public/org tier clip stays fresh.
        publicGeoBoundaryId: true,
        orgGeoBoundaryId: true,
      },
    });
    const referencedIds = new Set<string>();
    const referencedUrlKeys = new Set<string>();
    for (const r of rows) {
      const deps = extractDependencies(r);
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

  // ---------------------------------------------------------------
  // Orphaned MinIO uploads (reconciliation sweep)
  // ---------------------------------------------------------------

  /**
   * Storage prefixes the orphan sweep manages. These are exactly
   * the kinds whose objects are backed by a row (or an item.data
   * field) that the upload flow writes AFTER the bytes land in
   * MinIO, which is what makes an unreferenced object under them a
   * leak rather than a design feature:
   *
   *   feature-attachment/  -> feature_attachment.storage_key
   *   item-file/           -> item.data.storageKey / item.storage_ref
   *   item-tile-layer/     -> item.data storageKey / cogStorageKey /
   *                           pmtilesStorageKey
   *   item-point-cloud/    -> item.data storageKey + sources[] keys
   *                           (+ analysis_job params for merges)
   *   map-icon/            -> map_icon_upload.storage_key
   *
   * Deliberately NOT swept: the public image prefixes (item-thumb,
   * group-thumb, user-avatar, org-hero). Those are referenced only
   * as loose URL strings scattered across item.thumbnailUrl,
   * user.avatarUrl, group thumbnails, org landing config, and
   * cloned web-app JSON; the objects are small (5 MB cap), so the
   * downside of a false-positive delete (broken images all over
   * the portal) dwarfs the bytes reclaimed. Backups and golden
   * snapshots never live in this bucket at all (BackupService
   * writes tar archives to BACKUP_DIR on disk; infra golden
   * snapshots are host-side), so they cannot be touched here.
   */
  private static readonly ORPHAN_SWEEP_PREFIXES = [
    'feature-attachment',
    'item-file',
    'item-tile-layer',
    'item-point-cloud',
    'map-icon',
  ] as const;

  /**
   * Minimum object age before the sweep will even look at it.
   * 48 hours default: presigned PUT windows are 60 to 600 seconds
   * and every upload flow writes its referencing row immediately
   * after the PUT, so anything unreferenced after two days is a
   * crashed or abandoned flow, not one that is still in flight.
   */
  private get orphanMinAgeHours(): number {
    return this.resolvePositive('HOUSEKEEPING_ORPHAN_UPLOAD_MIN_AGE_HOURS', 48);
  }

  /**
   * Every storage key any row in the database still points at, for
   * the managed prefixes. Sources, in one pass each:
   *
   *   - feature_attachment.storage_key (the authoritative
   *     attachment registry, including AGO-import and form
   *     submission attachments which register here too)
   *   - map_icon_upload.storage_key
   *   - item.storage_ref (file-shaped items persist the raw key
   *     here as well as in data.storageKey; the private-read
   *     controller honors both, so the sweep must too)
   *   - regex extraction over the JSON text of item.data_json,
   *     item_data_snapshot.data, analysis_job.params, and
   *     form_submission.response. Text-level matching is the
   *     conservative choice: it catches every shape a key can be
   *     embedded in (bare key fields, api-mediated URLs, cloned
   *     web-app config, point-cloud sources arrays, denormalized
   *     storageUrl snapshots) without needing to enumerate them.
   *     Soft-deleted items are INCLUDED on purpose: restoring from
   *     trash must not resurrect a row whose bytes we deleted, and
   *     the same goes for data snapshots an admin can revert to.
   *
   * A key that appears anywhere here is off-limits, whichever org
   * owns it: the bucket is instance-global, so the reference scan
   * must be too.
   */
  private async referencedStorageKeys(): Promise<Set<string>> {
    const referenced = new Set<string>();

    const [attachments, icons, storageRefs] = await Promise.all([
      this.prisma.featureAttachment.findMany({
        select: { storageKey: true },
      }),
      this.prisma.mapIconUpload.findMany({ select: { storageKey: true } }),
      this.prisma.item.findMany({
        where: { storageRef: { not: null } },
        select: { storageRef: true },
      }),
    ]);
    for (const a of attachments) referenced.add(a.storageKey);
    for (const i of icons) referenced.add(i.storageKey);
    for (const r of storageRefs) {
      if (r.storageRef) referenced.add(r.storageRef);
    }

    // One statement for all four JSON surfaces. The pattern matches
    // `<managed-prefix>/<uuid>` anywhere in the serialized JSON.
    const pattern =
      '((?:feature-attachment|item-file|item-tile-layer|item-point-cloud|map-icon)/[0-9a-fA-F-]{36})';
    const rows = await this.prisma.$queryRaw<Array<{ k: string }>>`
      SELECT DISTINCT k FROM (
        SELECT (regexp_matches(i.data_json::text, ${pattern}, 'g'))[1] AS k
          FROM "item" i
        UNION ALL
        SELECT (regexp_matches(s.data::text, ${pattern}, 'g'))[1]
          FROM "item_data_snapshot" s
        UNION ALL
        SELECT (regexp_matches(a.params::text, ${pattern}, 'g'))[1]
          FROM "analysis_job" a
        UNION ALL
        SELECT (regexp_matches(f.response::text, ${pattern}, 'g'))[1]
          FROM "form_submission" f
      ) u
    `;
    for (const r of rows) referenced.add(r.k);
    return referenced;
  }

  /**
   * Shared collection step for the report and the purge. Lists the
   * managed prefixes, drops anything younger than the age floor or
   * still referenced, and returns the rest. The purge recomputes
   * this from scratch at purge time; the client never submits a
   * key list, so a stale browser tab cannot delete something that
   * got referenced since the report rendered.
   */
  private async collectOrphanedUploads(): Promise<{
    unavailable: boolean;
    perPrefix: Array<{
      prefix: string;
      objectCount: number;
      orphanCount: number;
      orphanBytes: number;
    }>;
    orphans: Array<{ key: string; sizeBytes: number; lastModified: string | null }>;
  }> {
    const cutoffMs = Date.now() - this.orphanMinAgeHours * 60 * 60 * 1000;
    let referenced: Set<string>;
    const perPrefix: Array<{
      prefix: string;
      objectCount: number;
      orphanCount: number;
      orphanBytes: number;
    }> = [];
    const orphans: Array<{
      key: string;
      sizeBytes: number;
      lastModified: string | null;
    }> = [];
    try {
      referenced = await this.referencedStorageKeys();
      for (const prefix of HousekeepingService.ORPHAN_SWEEP_PREFIXES) {
        const objects = await this.storage.listObjectsUnder(`${prefix}/`);
        let orphanCount = 0;
        let orphanBytes = 0;
        for (const obj of objects) {
          // Unknown age = treat as fresh. Never delete an object we
          // cannot prove is past the age floor.
          const age = obj.lastModified ? obj.lastModified.getTime() : Infinity;
          if (age > cutoffMs) continue;
          if (referenced.has(obj.key)) continue;
          orphanCount += 1;
          orphanBytes += obj.sizeBytes;
          orphans.push({
            key: obj.key,
            sizeBytes: obj.sizeBytes,
            lastModified: obj.lastModified?.toISOString() ?? null,
          });
        }
        perPrefix.push({
          prefix,
          objectCount: objects.length,
          orphanCount,
          orphanBytes,
        });
      }
    } catch (err) {
      // MinIO down or the reference scan failed: report unavailable
      // rather than an empty (or worse, partial) orphan list.
      this.log.warn(
        `Orphaned-upload scan unavailable: ${
          err instanceof Error ? err.message : err
        }`,
      );
      return { unavailable: true, perPrefix: [], orphans: [] };
    }
    return { unavailable: false, perPrefix, orphans };
  }

  /**
   * Dry-run report for the admin page: counts and bytes only, plus
   * a bounded key sample so the admin can eyeball what a delete
   * would remove. Nothing is deleted here; the destructive step is
   * a separate explicit POST (purgeOrphanedUploads).
   */
  async orphanedUploadsReport() {
    const collected = await this.collectOrphanedUploads();
    const totalBytes = collected.orphans.reduce(
      (sum, o) => sum + o.sizeBytes,
      0,
    );
    return {
      unavailable: collected.unavailable,
      minAgeHours: this.orphanMinAgeHours,
      perPrefix: collected.perPrefix,
      orphanCount: collected.orphans.length,
      orphanBytes: totalBytes,
      // Enough to sanity-check, small enough to render.
      sample: collected.orphans.slice(0, 25),
    };
  }

  /**
   * Destructive half of the sweep. Recomputes the orphan set from
   * scratch (see collectOrphanedUploads for why) and deletes each
   * object, tallying honest per-object success. freedBytes counts
   * only objects whose delete call succeeded.
   */
  async purgeOrphanedUploads(): Promise<{
    unavailable: boolean;
    minAgeHours: number;
    deletedCount: number;
    freedBytes: number;
    failedCount: number;
  }> {
    const collected = await this.collectOrphanedUploads();
    if (collected.unavailable) {
      return {
        unavailable: true,
        minAgeHours: this.orphanMinAgeHours,
        deletedCount: 0,
        freedBytes: 0,
        failedCount: 0,
      };
    }
    let deletedCount = 0;
    let freedBytes = 0;
    let failedCount = 0;
    for (const orphan of collected.orphans) {
      const ok = await this.storage.deleteObject(orphan.key);
      if (ok) {
        deletedCount += 1;
        freedBytes += orphan.sizeBytes;
      } else {
        failedCount += 1;
      }
    }
    this.log.log(
      `Orphaned-upload purge: deleted ${deletedCount} object(s), ` +
        `${freedBytes} bytes freed, ${failedCount} failed.`,
    );
    return {
      unavailable: false,
      minAgeHours: this.orphanMinAgeHours,
      deletedCount,
      freedBytes,
      failedCount,
    };
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
          next = await this.dataLayerTables.aggregateBbox(it.id, layers);
          // Same maintenance pass keeps per-layer featureCount
          // honest; this is also the backfill for items created
          // before the field was maintained (the QGIS plugin's
          // feature-vs-tiles default reads it). Best-effort: a
          // count failure must not sink the extent recompute.
          try {
            await this.dataLayerTables.stampFeatureCounts(it.id);
          } catch {
            // logged inside the stamper's count helper
          }
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
/**
 * Parse a `data_layer:<itemId>:<layerId>` scope string back to its
 * components. Returns null if the format doesn't match (so we don't
 * accidentally mis-attribute a non-data_layer scope to an item).
 */
function parseScope(scope: string): { itemId: string; layerId: string } | null {
  const parts = scope.split(':');
  if (parts.length !== 3) return null;
  if (parts[0] !== 'data_layer') return null;
  const itemId = parts[1];
  const layerId = parts[2];
  if (!itemId || !layerId) return null;
  return { itemId, layerId };
}

/**
 * Project an item's `data` JSON down to a `layerId -> label` map for
 * the Storage by data layer table. Returns null when the item isn't
 * v3-shaped (no `data.layers[]`) so callers can fall back to the
 * storage key. Tolerates partial shapes: a v3 item with `data.layers`
 * but missing labels still resolves -- we prefer `label`, fall through
 * to `name`, and skip entries that have neither. Untyped (uses `unknown`
 * walks) because the column is a Prisma `Json` type at this layer;
 * shared-types `DataLayerSublayer` is the authoritative schema but
 * isn't a runtime guard.
 */
function readSublayerLabels(data: unknown): Map<string, string> | null {
  if (!data || typeof data !== 'object') return null;
  const layers = (data as { layers?: unknown }).layers;
  if (!Array.isArray(layers)) return null;
  const out = new Map<string, string>();
  for (const raw of layers) {
    if (!raw || typeof raw !== 'object') continue;
    const obj = raw as Record<string, unknown>;
    const id = typeof obj.id === 'string' ? obj.id : null;
    if (!id) continue;
    const label =
      typeof obj.label === 'string' && obj.label.length > 0
        ? obj.label
        : typeof obj.name === 'string' && obj.name.length > 0
          ? (obj.name as string)
          : null;
    if (label) out.set(id, label);
  }
  return out.size > 0 ? out : null;
}

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
function readV3Layers(data: unknown): DataLayerLayerShape[] | null {
  if (!data || typeof data !== 'object') return null;
  const v = (data as { version?: unknown; layers?: unknown }).version;
  if (v !== 3 && v !== '3') return null;
  const layers = (data as { layers?: unknown }).layers;
  if (!Array.isArray(layers)) return null;
  const out: DataLayerLayerShape[] = [];
  for (const l of layers) {
    if (!l || typeof l !== 'object') continue;
    const id = (l as { id?: unknown }).id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const gt = (l as { geometryType?: unknown }).geometryType;
    const geometryType: DataLayerLayerShape['geometryType'] =
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
