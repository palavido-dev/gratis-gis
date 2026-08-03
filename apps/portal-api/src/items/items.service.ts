// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { ItemAccess, ItemType, PrincipalType, SharePermission } from '@prisma/client';
import { ITEM_TYPES, defaultThumbnailDesign } from '@gratis-gis/shared-types';

import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { SharingService } from './sharing.service.js';
import { DataSnapshotService } from './data-snapshot.service.js';
import { itemBbox } from './item-bbox.js';

/** Allow-list of types a smart folder's saved query can filter to.
 *  Just the runtime ITEM_TYPES set as a plain string array so we
 *  can use `.includes()` without a TS narrowing dance. */
const SMART_FOLDER_TYPES: readonly string[] = ITEM_TYPES;

/**
 * Mirrors MAX_CHAIN_DEPTH on DerivedLayersService (#78).  Kept as a
 * local copy so this layer doesn't import the constant from the
 * derived-layers module (one-directional dependency rule); the two
 * must move together if they ever change.
 */
const MAX_DERIVED_CHAIN_DEPTH = 5;

/**
 * Coarse degree-equivalent of a kilometer buffer. Good enough for
 * "show items near this region" search; not for any kind of
 * geodesic computation. 1 degree of latitude is roughly 111 km;
 * longitude varies with latitude so we err on the wide side.
 */
function degreesFromKm(km: number): number {
  return Math.min(Math.max(km, 0), 100_000) / 111;
}

/**
 * #66: synthesize a thumbnailUrl from the auto-thumbnail design blob
 * when the item doesn't carry an uploaded image. The SVG endpoint
 * reads the row's current title + type live, so all this URL needs
 * to do is point at the right item with a cache-buster keyed on
 * updatedAt; renames bump updatedAt, browsers refetch.  Rows that
 * already carry an uploaded thumbnailUrl pass through untouched.
 */
import { synthesizeThumbnailUrl } from './thumbnail-url.js';
import {
  extractDependencies,
  normalizeArcgisUrl,
  REFERENCER_TYPES,
} from './dependency-extractor.js';
import {
  DataLayerTablesService,
  type DataLayerLayerShape,
} from '../data-layer/tables.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { DerivedLayersService } from '../derived-layers/derived-layers.service.js';
import { StorageService } from '../storage/storage.service.js';

// Optional fields use `| undefined` explicitly so class-validator DTOs
// (which leave unset keys present-as-undefined) can satisfy these types
// under `exactOptionalPropertyTypes: true`.
export interface CreateItemInput {
  /**
   * #217: explicit item id, used by the sample seeder to mint
   * DETERMINISTIC ids (uuidv5 of org + seedKind) so a purge +
   * reseed lands on the same id and hand-built maps referencing
   * seeded items never dangle. Internal callers only; the public
   * create endpoint's DTO does not carry this field, so it is
   * stripped before reaching here (same containment as seedKind).
   */
  id?: string | undefined;
  type: ItemType;
  title: string;
  description?: string | undefined;
  tags?: string[] | undefined;
  data: Prisma.InputJsonValue;
  access?: ItemAccess | undefined;
  /** Pass null or omit to start without a custom thumbnail. */
  thumbnailUrl?: string | null | undefined;
  /**
   * #66: optional thumbnail design override on create. When
   * provided, this exact design is stored; when omitted, the
   * service applies defaultThumbnailDesign(type).
   */
  thumbnailDesign?: Prisma.InputJsonValue | null | undefined;
  /** Open-data license; null / omitted = not recorded. */
  license?: string | null | undefined;
  /**
   * #22: stable identifier for items seeded from a built-in
   * starter (e.g. 'sidebar-explorer' on an app_template item).
   * Set by org-bootstrap and admin-restore; never accepted via
   * the public create endpoint, so a user-saved template stays
   * null and the restore flow correctly treats it as "not a
   * starter."  Callers that pass this also typically pass
   * ownerOverride to attribute the seed to the org admin.
   */
  seedKind?: string | null | undefined;
}

export interface UpdateItemInput {
  title?: string | undefined;
  description?: string | undefined;
  tags?: string[] | undefined;
  data?: Prisma.InputJsonValue | undefined;
  access?: ItemAccess | undefined;
  /** Pass null to clear. */
  thumbnailUrl?: string | null | undefined;
  /**
   * #66: pass a ThumbnailDesign blob to update the auto-thumbnail
   * rendering, or null to revert to the type-default design.
   */
  thumbnailDesign?: Prisma.InputJsonValue | null | undefined;
  /** Pass null to clear a previously-set license. */
  license?: string | null | undefined;
  /**
   * #80: tier-level geo limits. UUID of a geo_boundary item, or
   * null to clear. Read path treats missing / wrong-typed targets
   * as no-clip; this DTO does not validate the target is a real
   * geo_boundary so an honest typo doesn't 4xx the save.
   */
  publicGeoBoundaryId?: string | null | undefined;
  orgGeoBoundaryId?: string | null | undefined;
  /**
   * Optimistic-concurrency precondition. When supplied, the update
   * only lands if the row's current updatedAt matches this ISO
   * timestamp exactly; otherwise the service throws 409 Conflict so
   * the client can refetch instead of silently overwriting someone
   * else's save. Opt-in: clients that never send it keep the old
   * last-write-wins behaviour, so no existing editor breaks.
   */
  expectedUpdatedAt?: string | undefined;
}

/**
 * Options accepted by list() / listPaged(). Extracted to a named
 * interface so the WHERE builder, the row query, and the count can
 * all share one shape without re-declaring the inline type.
 */
export interface ItemsListOptions {
  mine?: boolean;
  /**
   * Single ItemType or array of types. The controller normalises
   * a comma-separated `?type=` query into one or the other so a
   * caller fetching both data_layer and arcgis_service can do it
   * in one round-trip.
   */
  type?: ItemType | ItemType[];
  q?: string;
  /**
   * Subset of fields the `q` search targets. Defaults to all
   * three (title, description, tags) when omitted; smart
   * folders (#38) pass a narrower list when the author wants
   * to scope the search.
   */
  searchFields?: Array<'title' | 'description' | 'tags'>;
  /**
   * Filter to items owned by a specific user. Intended for the
   * admin 'user delete -> reassign their items' flow. Anyone may
   * filter by their own id (equivalent to `mine: true`); filtering
   * by anyone else's id requires org-admin, enforced below.
   */
  ownerId?: string;
  /**
   * Optional spatial filter. When set, the list is restricted to
   * items whose cached `bbox_geom` (set by ItemsService on save
   * via itemBbox()) intersects the given envelope. EPSG:4326,
   * [west, south, east, north]. Items without a cached bbox are
   * NOT excluded; the spatial filter narrows, not gates, so
   * non-spatial item types (forms, dashboards, etc.) keep showing
   * up alongside the spatial matches. (#24)
   */
  bbox?: [number, number, number, number];
  /**
   * Buffer (km) expanding the user's bbox before the intersect
   * check. Lets a user search "around this area" rather than
   * "strictly inside". Defaults to 0; clamped to [0, 100000] at
   * the controller. Buffering is done in degrees as a coarse
   * approximation (deg ~ 111 km at the equator) so we don't
   * incur a per-row reproject; it's a search heuristic, not a
   * survey-grade query.
   */
  bufferKm?: number;
  /**
   * Slim projection: when true, the response omits the heavy
   * `data` JSONB blob and instead attaches small derived fields:
   * `_subLayerCount` on arcgis_service rows, `_storageType` and
   * `_layers` on data_layer rows, and `_template` on web_app rows
   * so list surfaces can badge / route without the payload. This
   * is the DEFAULT for the HTTP list endpoint now; callers that
   * genuinely need the payload for every row pass ?full=1. (#52)
   */
  lite?: boolean;
  /**
   * Filter to items that have an active share row pointing at the
   * given group (#100). The Add Layer dialog's Groups tab uses
   * this so an author drilling into a group sees only the items
   * the group has been granted access to. Note we still apply
   * `visibleWhere`: a non-member of the group with no other
   * route to an item should not see it appear here. The intersection
   * is the right "items in this group from my perspective" set.
   */
  sharedWithGroupId?: string;
  /**
   * Page size. Optional at this layer so internal callers (smart
   * folders, admin sweeps) keep the historic unbounded behaviour;
   * the HTTP controller always passes a bounded value (default
   * 500, hard cap 1000).
   */
  limit?: number;
  /** Rows to skip before the page starts. Pairs with `limit`. */
  offset?: number;
}

/**
 * Cascade-delete preview for a folder (#156). Lists the subfolders
 * that would be soft-deleted alongside the target because their
 * only non-trashed parent is in the cascade set, plus a count of
 * non-folder items that would lose their folder reference (but
 * stay intact themselves, since folders are a view, not a gate).
 *
 * Returned by previewFolderDeleteCascade() and also embedded in
 * the 409 response body when remove() refuses a folder delete
 * without `cascade=true`.
 */
export interface FolderDeleteCascadePreview {
  /**
   * Subfolders that will be soft-deleted alongside the parent.
   * Excludes the root folder itself (the caller already knows
   * it's being deleted). Order is BFS-walk order so a tree like
   * A -> B -> C lists B before C.
   */
  folders: Array<{ id: string; title: string }>;
  /**
   * Count of non-folder items contained by the cascade set.
   * Those items are not deleted; they only lose the folder
   * reference once the trashed folder is purged. The count is
   * surfaced in the confirmation dialog so the user knows the
   * scope of the unlink side-effect.
   */
  unlinkedItemCount: number;
}

/**
 * Pure cascade-walk used by previewFolderDeleteCascade(). Lives at
 * module scope so it can be unit-tested without a Prisma client: the
 * service method does the DB load and hands the folder list in.
 *
 * `folders` should contain every non-trashed folder in the org. Each
 * entry's childItemIds is the folder's authoritative member list
 * (smart folders should be passed in with childItemIds: []).
 *
 * Returns the cascade set excluding the root, plus the count of
 * non-folder children that would lose their folder reference. The
 * BFS respects multi-parent: a subfolder filed under both the
 * trashed parent and an unrelated alive folder is preserved
 * because at least one of its parents stays alive.
 */
export function computeFolderCascade(
  rootId: string,
  folders: Array<{ id: string; title: string; childItemIds: string[] }>,
): FolderDeleteCascadePreview {
  const folderIdSet = new Set(folders.map((f) => f.id));
  const folderTitleById = new Map(folders.map((f) => [f.id, f.title]));
  const childrenByFolder = new Map<string, string[]>(
    folders.map((f) => [f.id, f.childItemIds]),
  );
  // child UUID -> set of parent folder UUIDs. Built by reading the
  // childItemIds of every folder, so multi-parent surfaces naturally.
  const parentsByChild = new Map<string, Set<string>>();
  for (const f of folders) {
    for (const kid of f.childItemIds) {
      let bag = parentsByChild.get(kid);
      if (!bag) {
        bag = new Set<string>();
        parentsByChild.set(kid, bag);
      }
      bag.add(f.id);
    }
  }

  // Defensive: if the root isn't a folder in the supplied list,
  // return the no-op preview so a stale id can't crash the BFS.
  if (!folderIdSet.has(rootId)) {
    return { folders: [], unlinkedItemCount: 0 };
  }

  // Pass 1: fixed-point cascade computation. Naive single-pass BFS
  // is order-dependent in the multi-parent case -- if subfolder B
  // has parents A and C, processing B before adding C to the
  // cascade incorrectly classifies B as "survives". Iterating
  // until no further folders are added removes the order
  // dependence and produces the deterministic correct set:
  // a folder cascades iff (a) it is reachable from the root and
  // (b) every parent of it is in the cascade.
  const cascadeSet = new Set<string>([rootId]);
  // Iteration bound: the cascade can grow at most once per folder,
  // so |folders|+1 iterations is a safe upper bound. We hit the
  // bound only if the graph is pathological; normal trees stop in
  // the first or second iteration.
  let grew = true;
  let safetyBudget = folders.length + 1;
  while (grew && safetyBudget > 0) {
    grew = false;
    safetyBudget -= 1;
    for (const f of folders) {
      if (cascadeSet.has(f.id)) continue;
      const parents = parentsByChild.get(f.id);
      if (!parents || parents.size === 0) continue; // unreachable root.
      // Must touch the cascade somewhere.
      let touchesCascade = false;
      let allParentsInCascade = true;
      for (const p of parents) {
        if (cascadeSet.has(p)) touchesCascade = true;
        else allParentsInCascade = false;
      }
      if (!touchesCascade || !allParentsInCascade) continue;
      cascadeSet.add(f.id);
      grew = true;
    }
  }

  // Pass 2: BFS the cascade in walk order to produce the
  // user-facing list, and collect unique non-folder unlinks. The
  // visited set guards against (a) revisiting cascade folders via
  // multiple parents and (b) double-counting an item that's filed
  // under two cascade folders.
  const cascadeFolders: Array<{ id: string; title: string }> = [];
  const unlinkedSet = new Set<string>();
  const visited = new Set<string>([rootId]);
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const here = queue.shift() as string;
    const kids = childrenByFolder.get(here) ?? [];
    for (const kidId of kids) {
      if (visited.has(kidId)) continue;
      visited.add(kidId);
      if (folderIdSet.has(kidId)) {
        if (cascadeSet.has(kidId)) {
          cascadeFolders.push({
            id: kidId,
            title: folderTitleById.get(kidId) ?? '(untitled folder)',
          });
          queue.push(kidId);
        }
        // else: surviving subfolder, don't descend through it.
      } else {
        // Non-folder: count once per unique UUID.
        unlinkedSet.add(kidId);
      }
    }
  }

  return { folders: cascadeFolders, unlinkedItemCount: unlinkedSet.size };
}

export interface ShareItemInput {
  principalType: PrincipalType;
  principalId: string;
  permission?: SharePermission | undefined;
  /**
   * Inline geographic restriction. When present, the share's
   * grantee only sees features that intersect this polygon (plus
   * items whose bbox does). Pass `null` to explicitly clear a
   * previously-set limit; omit the field to leave it untouched.
   * GeoJSON in EPSG:4326. Mutually exclusive with `geoBoundaryId`:
   * the service writes one and clears the other on each update.
   */
  geoLimit?: unknown | null;
  /**
   * Reference to a geo_boundary item whose geometry supplies the
   * clip. Pass `null` to clear; omit to leave untouched.
   * Mutually exclusive with `geoLimit`.
   */
  geoBoundaryId?: string | null | undefined;
  /**
   * Row-level scope (#40). `'all'` (default for new shares) lets the
   * principal see every feature; `'own'` narrows to features they
   * created. Admins / item owner bypass at the service layer.
   */
  rowScope?: 'all' | 'own' | undefined;
  /**
   * Optional expiry timestamp (#84). Pass an ISO date string (or a
   * Date) to set a hard end-time for the share; pass `null` to
   * clear a previously-set expiry; omit the field to leave it
   * untouched. After the timestamp the share is filtered out at
   * request time and eventually swept by housekeeping cron.
   */
  expiresAt?: string | Date | null | undefined;
}

@Injectable()
export class ItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sharing: SharingService,
    private readonly dataLayerTables: DataLayerTablesService,
    private readonly snapshots: DataSnapshotService,
    private readonly notifications: NotificationsService,
    private readonly derivedLayers: DerivedLayersService,
    private readonly storage: StorageService,
  ) {}

  async list(user: AuthUser, opts: ItemsListOptions = {}) {
    const where = await this.buildListWhere(user, opts);
    return this.queryListRows(where, opts);
  }

  /**
   * Paged list plus a total count for the HTTP surface. Builds the
   * WHERE clause once and runs the page query and the count in
   * parallel so X-Total-Count always describes the same filter set
   * the rows came from (type / q / scope / bbox included). Kept
   * separate from list() so internal callers (smart folders, folder
   * resolution) keep the historic unbounded, no-count behaviour.
   */
  async listPaged(
    user: AuthUser,
    opts: ItemsListOptions = {},
  ): Promise<{ rows: unknown[]; total: number }> {
    const where = await this.buildListWhere(user, opts);
    const [rows, total] = await Promise.all([
      this.queryListRows(where, opts),
      this.prisma.item.count({ where }),
    ]);
    return { rows, total };
  }

  /**
   * Shared WHERE builder for list() / listPaged(). Async because
   * the spatial filter resolves candidate ids through a raw
   * PostGIS query before the Prisma query runs.
   */
  private async buildListWhere(
    user: AuthUser,
    opts: ItemsListOptions,
  ): Promise<Prisma.ItemWhereInput> {
    const where: Prisma.ItemWhereInput = opts.mine
      ? { ownerId: user.id, deletedAt: null }
      : this.sharing.visibleWhere(user);

    // Folder-share cascade was retired 2026-04-26 (#68). Folder
    // shares grant access to the folder itself (#63), not its
    // contents. Authors who want a folder's audience to also see
    // the items inside use the "Apply folder sharing" bulk action
    // on the folder page (#67), which writes real share rows on
    // each child item. Cleaner contract: items.list answers from
    // visibleWhere alone; no inherited-id splicing.
    if (opts.type) {
      where.type = Array.isArray(opts.type) ? { in: opts.type } : opts.type;
    }
    if (opts.ownerId && opts.ownerId !== user.id && user.orgRole !== 'admin') {
      // Non-admins can only filter to their own items.
      throw new ForbiddenException(
        'Only org admins can filter items by another user',
      );
    }
    if (opts.ownerId) where.ownerId = opts.ownerId;
    // sharedWithGroupId (#100): restrict to items whose shares
    // include a row for the given group. Layered on top of the
    // existing visibleWhere so a user only sees items the group has
    // access to AND that they themselves are allowed to see (a non-
    // member would already be filtered out by visibleWhere).
    if (opts.sharedWithGroupId) {
      where.shares = {
        some: {
          principalType: 'group',
          principalId: opts.sharedWithGroupId,
        },
      };
    }
    if (opts.q) {
      // Default search is across title + description + tags.
      // Smart folders (#38) can narrow to a subset by passing
      // `searchFields`; every other caller passes nothing and
      // gets the all-three behaviour unchanged.
      const fields = opts.searchFields ?? ['title', 'description', 'tags'];
      const orClauses: Prisma.ItemWhereInput[] = [];
      if (fields.includes('title')) {
        orClauses.push({ title: { contains: opts.q, mode: 'insensitive' } });
      }
      if (fields.includes('description')) {
        orClauses.push({
          description: { contains: opts.q, mode: 'insensitive' },
        });
      }
      if (fields.includes('tags')) {
        orClauses.push({ tags: { has: opts.q } });
      }
      if (orClauses.length > 0) where.OR = orClauses;
    }
    // Spatial filter via the generated bbox_geom column + GiST
    // index. Done outside the Prisma `where` because Prisma can't
    // express geometry operators directly; the result is a SET of
    // ids that we intersect with the regular where via `id IN`.
    //
    // When an area filter is active we strictly restrict to spatial
    // item types (the user explicitly asked "what's in this area?";
    // folders / pick-lists / basemaps don't have a footprint and
    // shouldn't pad the result). We also drop the previous
    // pass-through for items with empty bbox: a stored `bbox = []`
    // means we don't know where the item lives, so we can't claim
    // it's inside the user's area. Items without a known extent
    // surface as "no results" rather than as false positives.
    // Note: data_layers/maps that haven't had their feature extent
    // computed yet (seeded fixtures, pre-#24 rows) will be hidden
    // here until something writes an extent into item.bbox.
    if (opts.bbox) {
      const buf = degreesFromKm(opts.bufferKm ?? 0);
      const [w, s, e, n] = opts.bbox;
      // Filter trashed items out of the spatial id set up front. The
      // visibleWhere AND clause already excludes deletedAt != null
      // for the non-mine path, but $queryRaw runs against the bare
      // table so we need to repeat it here for safety. Prevents a
      // recently-deleted item from sneaking into search results just
      // because it has a non-null bbox_geom.
      const ids = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "item"
        WHERE "bbox_geom" IS NOT NULL
          AND "deleted_at" IS NULL
          AND "bbox_geom" && ST_MakeEnvelope(
            ${w - buf}, ${s - buf}, ${e + buf}, ${n + buf}, 4326
          )
      `;
      const idSet = ids.map((r) => r.id);
      // visibleWhere(user) returns `{ AND: [access, { deletedAt: null }] }`
      // so `where.AND` is already populated. Direct assignment would
      // overwrite the deletedAt filter (this used to leak trashed
      // items into spatial search results in the "All items" view).
      // Preserve the existing AND clauses by appending instead.
      const existingAnd = Array.isArray(where.AND)
        ? where.AND
        : where.AND
          ? [where.AND]
          : [];
      where.AND = [
        ...existingAnd,
        {
          type: {
            in: [
              'map',
              'data_layer',
              'arcgis_service',
              'wms_service',
              'wfs_service',
              'geo_boundary',
            ],
          },
        },
        { id: { in: idSet } },
      ];
    }
    return where;
  }

  /**
   * Run the list SELECT (plus lite-mode annotations) for a prebuilt
   * WHERE clause. Split from list() so listPaged() can reuse the
   * exact same projection while running the count off the same
   * WHERE object.
   */
  private async queryListRows(
    where: Prisma.ItemWhereInput,
    opts: ItemsListOptions,
  ) {
    // Lightweight per-call timing log behind the ITEMS_LIST_TIMING env
    // flag so a slow load can be diagnosed without hand-instrumenting
    // every request. Overhead is one Date.now() per phase so it is
    // safe to leave on in production if needed.
    const traceTiming = process.env.ITEMS_LIST_TIMING === '1';
    const tStart = traceTiming ? Date.now() : 0;
    // Include shares in the list response so the items page can render
    // sharing badges without a second round-trip per item. Most items
    // have zero-to-single-digit share rows, so the extra join is cheap
    // and far better than N+1 fetches on the client.
    // Also include a lean owner projection (username, fullName, avatar)
    // so the Owner column can render without N+1 lookups.
    //
    // Lite mode (#52): omit the heavy data_json blob from the
    // response. The list view doesn't need most of what's in there;
    // arcgis_service items get a derived `_subLayerCount` attached
    // below so the dialog can still render the "+N layers" badge.
    const baseSelect = {
      id: true,
      orgId: true,
      ownerId: true,
      type: true,
      title: true,
      description: true,
      tags: true,
      thumbnailUrl: true,
      // #66: auto-thumbnail design blob.  Small (under 200 bytes per
      // row); cheap to ship in the list payload so consumers don't
      // need a second request to render the SVG fallback.
      thumbnailDesign: true,
      license: true,
      storageRef: true,
      access: true,
      createdAt: true,
      updatedAt: true,
      deletedAt: true,
      bbox: true,
      bboxSrs: true,
      shares: true,
      owner: {
        select: {
          id: true,
          username: true,
          fullName: true,
          avatarUrl: true,
        },
      },
    } as const;
    // Pagination is opt-in at this layer: the HTTP controller always
    // passes a bounded limit (default 500, cap 1000) while internal
    // callers omit both knobs and keep the full result set. Built as
    // conditional spreads so an absent knob never reaches Prisma as
    // an explicit-undefined key (exactOptionalPropertyTypes).
    const page = {
      ...(typeof opts.limit === 'number' && opts.limit > 0
        ? { take: Math.floor(opts.limit) }
        : {}),
      ...(typeof opts.offset === 'number' && opts.offset > 0
        ? { skip: Math.floor(opts.offset) }
        : {}),
    };
    const rows = opts.lite
      ? await this.prisma.item.findMany({
          where,
          select: baseSelect,
          orderBy: { updatedAt: 'desc' },
          ...page,
        })
      : await this.prisma.item.findMany({
          where,
          select: { ...baseSelect, data: true },
          orderBy: { updatedAt: 'desc' },
          ...page,
        });

    let result: unknown[] = rows;
    if (opts.lite) {
      // Compute _subLayerCount for arcgis_service rows in one
      // targeted raw query. Postgres reads only the JSONB path we
      // care about (selectedLayerIds length, falling back to layers
      // length, then 0) so the trip back is a couple of integers
      // per row, not the whole metadata blob. Layered on top of
      // the slim findMany so the network payload stays small.
      const arcIds = rows
        .filter((r) => r.type === 'arcgis_service')
        .map((r) => r.id);
      const counts = new Map<string, number>();
      if (arcIds.length > 0) {
        const counted = await this.prisma.$queryRaw<
          Array<{ id: string; sublayer_count: number }>
        >`
          SELECT id::text AS id,
                 COALESCE(
                   jsonb_array_length(data_json -> 'selectedLayerIds'),
                   jsonb_array_length(data_json -> 'layers'),
                   0
                 )::int AS sublayer_count
          FROM "item"
          WHERE id = ANY(${arcIds}::uuid[])
        `;
        for (const c of counted) counts.set(c.id, c.sublayer_count);
      }

      // Compute lite-mode annotations for data_layer rows in one
      // targeted raw query. The lite findMany strips `data` to keep
      // the wire payload small, but downstream UI surfaces (the
      // derived-layer wizard, future analysis tools) need three
      // small derived facts:
      //   - `_storageType`: tells v1 inline-GeoJSON apart from v2 /
      //     v3 PostGIS-backed layers.
      //   - `_layers`: for v3 multi-layer items, the per-sublayer
      //     {id, label, geometryType} list so the picker can flatten
      //     sublayers into selectable rows.
      // Reads only the JSON paths we care about so the trip back is
      // one string + a small array per row, not the whole metadata
      // blob.
      const dataLayerIds = rows
        .filter((r) => r.type === 'data_layer')
        .map((r) => r.id);
      const storageTypes = new Map<string, string>();
      const sublayerInfo = new Map<
        string,
        Array<{ id: string; label: string; geometryType: string | null }>
      >();
      if (dataLayerIds.length > 0) {
        const storage = await this.prisma.$queryRaw<
          Array<{
            id: string;
            storage_type: string | null;
            layers: unknown;
          }>
        >`
          SELECT id::text AS id,
                 (data_json ->> 'storageType') AS storage_type,
                 (data_json -> 'layers')        AS layers
          FROM "item"
          WHERE id = ANY(${dataLayerIds}::uuid[])
        `;
        for (const s of storage) {
          if (s.storage_type) storageTypes.set(s.id, s.storage_type);
          if (Array.isArray(s.layers)) {
            const slim: Array<{
              id: string;
              label: string;
              geometryType: string | null;
            }> = [];
            for (const raw of s.layers as unknown[]) {
              if (!raw || typeof raw !== 'object') continue;
              const o = raw as Record<string, unknown>;
              if (typeof o.id !== 'string') continue;
              slim.push({
                id: o.id,
                label: typeof o.label === 'string' ? o.label : o.id,
                geometryType:
                  typeof o.geometryType === 'string'
                    ? (o.geometryType as string)
                    : null,
              });
            }
            sublayerInfo.set(s.id, slim);
          }
        }
      }

      // Compute the `_template` discriminator for web_app rows.
      // Now that the list strips data_json by default, the items
      // page still needs to know whether a web_app row is an
      // editor / viewer / custom app to deep-link "Open" into the
      // right runtime and to drive the template facet. One string
      // per row instead of the full app config. The two boolean
      // key-existence probes reproduce the legacy-shape tolerance
      // in shared-types isEditorItem / isViewerItem (rows saved
      // before the WebAppData wrapper fix carry no `template` key
      // but are structurally recognisable).
      const webAppIds = rows
        .filter((r) => r.type === 'web_app')
        .map((r) => r.id);
      const templates = new Map<string, string | null>();
      if (webAppIds.length > 0) {
        const tpl = await this.prisma.$queryRaw<
          Array<{
            id: string;
            template: string | null;
            has_targets: boolean;
            has_snapping: boolean;
            has_tools: boolean;
          }>
        >`
          SELECT id::text AS id,
                 (data_json ->> 'template')          AS template,
                 jsonb_exists(data_json, 'targets')  AS has_targets,
                 jsonb_exists(data_json, 'snapping') AS has_snapping,
                 jsonb_exists(data_json, 'tools')    AS has_tools
          FROM "item"
          WHERE id = ANY(${webAppIds}::uuid[])
        `;
        for (const t of tpl) {
          const legacyShape =
            t.has_targets && t.has_snapping
              ? 'editor'
              : t.has_targets && t.has_tools
                ? 'viewer'
                : null;
          templates.set(t.id, t.template ?? legacyShape);
        }
      }

      result = rows.map((r) => {
        if (r.type === 'arcgis_service') {
          return { ...r, _subLayerCount: counts.get(r.id) ?? 0 };
        }
        if (r.type === 'data_layer') {
          // Default to 'inline' (v1) when the field is absent so the
          // client never has to special-case "missing means v1".
          return {
            ...r,
            _storageType: storageTypes.get(r.id) ?? 'inline',
            _layers: sublayerInfo.get(r.id) ?? [],
          };
        }
        if (r.type === 'web_app') {
          return { ...r, _template: templates.get(r.id) ?? null };
        }
        return r;
      });
    }

    if (traceTiming) {
      const tFindDone = Date.now();
      const typeLabel = Array.isArray(opts.type)
        ? opts.type.join('|')
        : (opts.type ?? 'any');
      // Pass user-influenced values (typeLabel, q) as separate args
      // rather than interpolating them into the format string. Keeps
      // any CR/LF or format-specifier characters from corrupting the
      // log stream (CodeQL js/log-injection). The old inherit phase
      // died with the where-builder split; findMany now measures
      // this method's whole query + annotation span.
      // eslint-disable-next-line no-console
      console.log(
        '[items.list] type=%s mine=%s lite=%s q=%s rows=%d ' +
          'findMany=%dms total=%dms',
        typeLabel,
        opts.mine ?? false,
        opts.lite ?? false,
        opts.q ?? '',
        rows.length,
        tFindDone - tStart,
        tFindDone - tStart,
      );
    }
    // #66: surface the auto-thumbnail URL for rows without an
    // uploaded image. Compute from the design blob + updatedAt
    // cache-buster so renames refresh the rendering.
    return (result as Array<{
      id: string;
      updatedAt: Date;
      thumbnailUrl: string | null;
      thumbnailDesign?: Prisma.JsonValue | null;
    }>).map(synthesizeThumbnailUrl);
  }

  /**
   * List the caller's trash. We deliberately scope this to items the
   * caller actually owns (plus org-admin) rather than anything they
   * could see-and-edit while it was live, so a collaborator can't
   * surface or restore someone else's deleted content. Owner-only
   * matches what users expect from a "my recycle bin" metaphor.
   */
  listTrash(user: AuthUser) {
    const where: Prisma.ItemWhereInput =
      user.orgRole === 'admin'
        ? { orgId: user.orgId, deletedAt: { not: null } }
        : { ownerId: user.id, deletedAt: { not: null } };
    return this.prisma.item.findMany({
      where,
      orderBy: { deletedAt: 'desc' },
      // Same lean owner projection as the live list and the detail
      // read. An org admin's trash shows other people's items, so the
      // rows need an owner label, and the pre-snapshot demo purge
      // (infra/cleanup-non-admin.mjs) keys its keep-or-purge decision
      // on owner.username and hard-aborts when it is missing. This
      // include is what that guard tripped on the first v0.9.0 golden
      // refresh: the endpoint had never serialized the owner at all.
      include: {
        owner: {
          select: {
            id: true,
            username: true,
            fullName: true,
            avatarUrl: true,
          },
        },
      },
    });
  }

  async get(user: AuthUser, id: string, opts: { includeTrashed?: boolean } = {}) {
    const item = await this.prisma.item.findUnique({
      where: { id },
      include: {
        shares: true,
        // Same lean owner projection the list endpoint uses, so the
        // detail page header can render "Owner: Contributor User" without
        // a separate lookup.
        owner: {
          select: {
            id: true,
            username: true,
            fullName: true,
            avatarUrl: true,
          },
        },
      },
    });
    if (!item) throw new NotFoundException('Item not found');
    // Trashed items are invisible to anyone except the owner and org admins,
    // and only when they explicitly ask for trashed items. This keeps a
    // soft-deleted item out of the normal read path entirely.
    if (item.deletedAt) {
      if (!opts.includeTrashed) throw new NotFoundException('Item not found');
      if (!this.sharing.canAdmin(user, item)) {
        throw new NotFoundException('Item not found');
      }
      return synthesizeThumbnailUrl(item);
    }
    if (!this.sharing.canRead(user, item, item.shares)) {
      // Don't leak existence; return 404 instead of 403 for unauthenticated reads
      throw new NotFoundException('Item not found');
    }
    // Viewers of a web map see a layer-filtered copy so the matrix
    // acts as actual enforcement (not just UI). Editors and admins
    // see the raw data so they can edit the matrix itself.
    if (
      item.type === 'map' &&
      !this.sharing.canEdit(user, item, item.shares)
    ) {
      const filtered = await this.filterMapForViewer(user, item.data);
      // Cast back to the original shape: filter returns `unknown`
      // because the dataJson contract is loose, but the rest of the
      // service expects Prisma's `JsonValue` so callers of get() see
      // the same type regardless of branch.
      return synthesizeThumbnailUrl({ ...item, data: filtered as typeof item.data });
    }
    return synthesizeThumbnailUrl(item);
  }

  /**
   * Apply per-layer access for a viewer. Walks each layer in the
   * web map and:
   *   1. Drops it if the viewer has no item-level access to the
   *      layer's backing source (data_layer today; arcgis_service
   *      + future types slot in the same way).
   *   2. Drops it if the layer's access policy is `custom` and the
   *      viewer has neither a direct entry nor a group entry with
   *      view=true.
   *   3. Annotates it with `effective: { view, query, edit }` so the
   *      client can gate popups / editing without re-deriving the
   *      permissions locally. `access.entries` is stripped so the
   *      full roster never leaves the server for non-editors.
   *
   * Backing items are fetched in a single batched query. Items the
   * caller can't read are treated the same as "doesn't exist".
   */
  private async filterMapForViewer(
    viewer: AuthUser,
    rawData: unknown,
  ): Promise<unknown> {
    if (!rawData || typeof rawData !== 'object') return rawData;
    const data = rawData as {
      layers?: Array<Record<string, unknown>>;
    };
    const layers = Array.isArray(data.layers) ? data.layers : [];
    // Fetch each backing data_layer / arcgis_service item and
    // its shares in one round-trip. Only layers that use an item id
    // are relevant; url / inline sources have no separate gatekeeping.
    const backingItemIds = new Set<string>();
    for (const l of layers) {
      const src = (l as { source?: { kind?: string; itemId?: string } })
        .source;
      if (
        src &&
        (src.kind === 'data-layer' || src.kind === 'arcgis_service') &&
        typeof src.itemId === 'string'
      ) {
        backingItemIds.add(src.itemId);
      }
    }
    const backingItems =
      backingItemIds.size > 0
        ? await this.prisma.item.findMany({
            where: { id: { in: [...backingItemIds] }, deletedAt: null },
            include: { shares: true },
          })
        : [];
    const byId = new Map(backingItems.map((i) => [i.id, i]));

    const out: Array<Record<string, unknown>> = [];
    for (const layer of layers) {
      const src = (layer as { source?: { kind?: string; itemId?: string } })
        .source;
      if (
        src &&
        (src.kind === 'data-layer' || src.kind === 'arcgis_service') &&
        typeof src.itemId === 'string'
      ) {
        const target = byId.get(src.itemId);
        if (!target) continue;
        if (!this.sharing.canRead(viewer, target, target.shares)) continue;
      }

      const access = (
        layer as {
          access?: {
            policy?: 'inherit' | 'custom';
            entries?: Array<{
              principalType: 'user' | 'group';
              principalId: string;
              view: boolean;
              query: boolean;
              edit: boolean;
            }>;
          };
        }
      ).access;

      let effective = { view: true, query: true, edit: false };
      if (access?.policy === 'custom') {
        const entry = (access.entries ?? []).find((e) => {
          if (e.principalType === 'user') return e.principalId === viewer.id;
          if (e.principalType === 'group') {
            return viewer.groupIds.includes(e.principalId);
          }
          return false;
        });
        if (!entry || !entry.view) continue;
        effective = {
          view: !!entry.view,
          query: !!entry.query,
          edit: !!entry.edit,
        };
      }

      const { access: _access, ...rest } = layer as Record<string, unknown> & {
        access?: unknown;
      };
      out.push({
        ...rest,
        // Preserve the policy so the client knows whether limits
        // applied, but drop the full entries array: that's who-
        // else-sees-what, not something a viewer should enumerate.
        access: { policy: access?.policy ?? 'inherit', entries: [] },
        effective,
      });
    }

    return { ...(data as Record<string, unknown>), layers: out };
  }

  async create(user: AuthUser, input: CreateItemInput) {
    // For map items, resolve the empty-string basemap sentinel from
    // DEFAULT_MAP to the org's seeded positron (or any available)
    // basemap item UUID so every new map opens against a real
    // basemap without the client needing to know any UUIDs up front.
    let resolvedData: Prisma.InputJsonValue =
      input.type === 'map'
        ? ((await this.resolveDefaultBasemap(
            user.orgId,
            input.data,
          )) as Prisma.InputJsonValue)
        : input.data;

    // For derived_layer items, validate the recipe + compute the
    // cached outputSchema and bbox before persisting. The source
    // ACL check is run here (not in DerivedLayersService) so the
    // module dependency stays one-directional.
    if (input.type === 'derived_layer') {
      resolvedData = (await this.enrichDerivedLayerData(
        user,
        input.data,
      )) as Prisma.InputJsonValue;
    }

    // For form items (#281c), auto-materialize a paired data_layer
    // unless the form already declares a linkedLayerId. This is the
    // load-bearing decision from #281: every form gets a durable,
    // typed home for its submissions from creation time. The form's
    // data records the layer id + sublayer key so the runtime, the
    // designer, and any future schema-mutation pipeline all know
    // where submissions go.
    //
    // Created-then-cleanup pattern (not a Prisma transaction)
    // because dataLayerTables.reconcile fires raw DDL outside the user
    // transaction. If the form persist fails after the layer was
    // created, we delete the orphan layer.
    let pairedLayerId: string | null = null;
    if (input.type === 'form') {
      const formData = (resolvedData ?? {}) as Record<string, unknown>;
      const alreadyLinked =
        typeof formData.linkedLayerId === 'string'
          && formData.linkedLayerId.length > 0;
      if (!alreadyLinked) {
        const paired = await this.createPairedDataLayerForForm(
          user,
          input.title,
        );
        pairedLayerId = paired.layerItemId;
        resolvedData = {
          ...formData,
          linkedLayerId: paired.layerItemId,
          linkedLayerKey: paired.layerKey,
        } as Prisma.InputJsonValue;
      }
    }

    const bbox = itemBbox(input.type, resolvedData);
    let row;
    try {
      // #66: every new item ships with an auto-generated thumbnail
      // design. The SVG is computed on the fly at request time so a
      // later rename automatically updates the rendering with no
      // re-bake. Authors can later customize via the thumbnail
      // designer; the design blob is the only state that needs to
      // change for the rendering to update. When the create form
      // supplies a custom design (user tweaked colors before
      // saving), pass it through unchanged.
      const thumbnailDesign =
        input.thumbnailDesign ?? defaultThumbnailDesign(input.type);
      row = await this.prisma.item.create({
        data: {
          ...(input.id ? { id: input.id } : {}),
          orgId: user.orgId,
          ownerId: user.id,
          type: input.type,
          title: input.title,
          description: input.description ?? '',
          tags: input.tags ?? [],
          data: resolvedData,
          access: input.access ?? 'private',
          bbox: bbox ?? [],
          thumbnailDesign: thumbnailDesign as unknown as Prisma.InputJsonValue,
          ...(input.thumbnailUrl ? { thumbnailUrl: input.thumbnailUrl } : {}),
          ...(input.license !== undefined && input.license !== null ? { license: input.license } : {}),
          ...(input.seedKind !== undefined && input.seedKind !== null
            ? { seedKind: input.seedKind }
            : {}),
        },
      });
    } catch (err) {
      // Roll back any paired data_layer created above so a failed
      // form persist doesn't leave an orphan layer (#281c).
      if (pairedLayerId) {
        await this.prisma.item
          .delete({ where: { id: pairedLayerId } })
          .catch(() => {
            /* best-effort cleanup */
          });
      }
      throw err;
    }
    // Phase 2.5: data_layer items no longer pre-provision per-layer
    // PostGIS tables. The engine substrate writes feature
    // observations to a shared `observation` table keyed by scope
    // (`data_layer:<itemId>:<layerId>`), so layer creation is a
    // pure metadata operation. The pre-engine reconcile pass that
    // ran here issued raw DDL outside the user transaction and
    // could leave half-created tables on failure, which is why the
    // caller cleaned up by deleting the item row. With no DDL to
    // run, neither concern applies; the item row is the only state
    // that needs to land.
    return synthesizeThumbnailUrl(row);
  }

  /**
   * Auto-materialize a paired data_layer for a freshly-created form
   * item (#281c). Every form gets a durable home for its submissions
   * from creation time so the form-versioning + schema-evolution
   * pipeline (see docs/forms-schema-mutation.md) has a stable target
   * to mutate against.
   *
   * Default schema: a single attribute-only sublayer "submissions"
   * with bookkeeping columns (submitted_at, submitted_by,
   * schema_version). geometryType=null until the form designer adds
   * a geometry question; #281d adds the geom column lazily through
   * the schema mutation API.
   *
   * The layer is created as a sibling item, not a child. Both are
   * owned by the same user, share the same access default, and live
   * in the same org. Caller is responsible for cleanup if the form
   * persist later fails.
   */
  private async createPairedDataLayerForForm(
    user: AuthUser,
    formTitle: string,
  ): Promise<{ layerItemId: string; layerKey: string }> {
    const layerKey = 'submissions';
    const layerData = {
      version: 3,
      storageType: 'postgis',
      layers: [
        {
          id: layerKey,
          label: 'Submissions',
          name: layerKey,
          // null until the form picks up a geometry question; that
          // event triggers an addColumn-with-geom mutation.
          geometryType: null,
          fields: [
            {
              name: 'submitted_at',
              type: 'date',
              label: 'Submitted at',
              nullable: false,
            },
            {
              name: 'submitted_by',
              type: 'string',
              label: 'Submitted by',
              nullable: true,
            },
            {
              name: 'schema_version',
              type: 'number',
              label: 'Schema version',
              nullable: false,
              storage: { numberKind: 'integer' as const },
            },
          ],
          editingEnabled: false,
          // Form attachment questions (#292) split out into the v3
          // feature_attachment table on submit, so the layer needs
          // attachments enabled for the attachment list / thumbnail
          // surfaces to light up in the data_layer detail page.
          attachmentsEnabled: true,
        },
      ],
    } as Prisma.InputJsonValue;
    const titlePrefix = formTitle.trim() || 'Form';
    const layerRow = await this.prisma.item.create({
      data: {
        orgId: user.orgId,
        ownerId: user.id,
        type: 'data_layer' as ItemType,
        title: `${titlePrefix} - Submissions`,
        description:
          'Auto-created by the form item this layer is paired with. ' +
          'Form-version-aware submissions land here.',
        tags: ['form-paired'],
        data: layerData,
        access: 'private',
        bbox: [],
      },
    });
    // Phase 2.5: paired submissions layers don't need a per-layer
    // PostGIS table either. The engine writes form submissions to
    // the shared observation log under
    // `data_layer:<layerItemId>:<layerKey>` like any other v3
    // layer; the metadata in `layerData` is enough on its own.
    return { layerItemId: layerRow.id, layerKey };
  }

  /**
   * Validate + enrich a derived_layer's `data` payload. Loads the
   * source data layer, runs an explicit canRead check (so a user
   * can't construct a derived layer over a layer they can't see),
   * then delegates to DerivedLayersService for the per-tool
   * validation, output-schema computation, and bbox padding.
   *
   * Returns the enriched data (with `outputSchema` and `bbox`
   * populated) ready to write to `item.data`. Throws
   * `BadRequestException` for any validation failure, including a
   * non-readable / wrong-type / trashed source.
   */
  private async enrichDerivedLayerData(
    user: AuthUser,
    rawData: Prisma.InputJsonValue,
  ): Promise<Prisma.JsonValue> {
    if (!rawData || typeof rawData !== 'object') {
      throw new BadRequestException('derived_layer data must be an object');
    }
    const sourceRef = (rawData as { source?: unknown }).source as
      | { itemId?: unknown }
      | undefined;
    if (!sourceRef || typeof sourceRef.itemId !== 'string') {
      throw new BadRequestException(
        'derived_layer.source.itemId is required',
      );
    }
    const source = await this.assertReadableDerivedLayerChain(
      user,
      sourceRef.itemId,
    );
    const enriched = await this.derivedLayers.validateAndEnrich(
      rawData,
      source,
    );
    return enriched as unknown as Prisma.JsonValue;
  }

  /**
   * Walk a derived_layer source chain and assert the caller can
   * read every layer along the way (#78).  Returns the immediate
   * source item so callers can pass it to
   * DerivedLayersService.validateAndEnrich.  Throws
   * BadRequestException for missing / trashed / unshared ancestors
   * or non-derived/non-data_layer interlopers.
   *
   * Uses the same existence-vs-access idiom items.service.get
   * uses: any failure surfaces as the same generic error message
   * regardless of whether the offending item was missing or just
   * unshared, so an attacker cannot probe for hidden item ids.
   */
  private async assertReadableDerivedLayerChain(
    user: AuthUser,
    startId: string,
  ): Promise<
    Prisma.ItemGetPayload<{ include: { shares: true } }>
  > {
    type NodeRow = Prisma.ItemGetPayload<{ include: { shares: true } }>;
    const visited = new Set<string>([startId]);
    let currentId: string | null = startId;
    let depth = 0;
    let immediate: NodeRow | null = null;
    while (currentId !== null) {
      const id: string = currentId;
      const node: NodeRow | null = await this.prisma.item.findUnique({
        where: { id },
        include: { shares: true },
      });
      if (
        !node ||
        node.deletedAt !== null ||
        !this.sharing.canRead(user, node, node.shares)
      ) {
        throw new BadRequestException(
          'derived_layer.source.itemId does not point at an accessible data layer',
        );
      }
      if (depth === 0) immediate = node;
      depth += 1;
      if (depth > 1 + MAX_DERIVED_CHAIN_DEPTH) {
        throw new BadRequestException(
          'derived_layer.source chain is too deep',
        );
      }
      if (node.type === 'data_layer') {
        return immediate!;
      }
      if (node.type !== 'derived_layer') {
        throw new BadRequestException(
          'derived_layer.source.itemId does not point at an accessible data layer',
        );
      }
      const parentSource = (
        node.data as { source?: { itemId?: unknown } } | null
      )?.source;
      const parentId: string | null =
        parentSource && typeof parentSource.itemId === 'string'
          ? parentSource.itemId
          : null;
      if (!parentId) {
        throw new BadRequestException(
          'derived_layer.source.itemId does not point at an accessible data layer',
        );
      }
      if (visited.has(parentId)) {
        throw new BadRequestException(
          'derived_layer.source chain has a cycle',
        );
      }
      visited.add(parentId);
      currentId = parentId;
    }
    // Unreachable in practice (the while-loop returns on
    // data_layer), but TypeScript wants a definite return.
    /* istanbul ignore next */
    if (!immediate) {
      throw new BadRequestException(
        'derived_layer.source.itemId does not point at an accessible data layer',
      );
    }
    return immediate;
  }

  /**
   * Preview a derived-layer recipe draft (#81).  Loads the source
   * with the same access check as `enrichDerivedLayerData`, then
   * delegates to DerivedLayersService.previewRecipe.  Used by the
   * builder's per-step Preview buttons.  Does NOT mutate state; the
   * recipe doesn't have to be persisted first.
   */
  async previewDerivedLayerRecipe(
    user: AuthUser,
    args: {
      source: {
        kind: 'data_layer' | 'derived_layer';
        itemId: string;
        layerKey?: string;
      };
      pipeline: unknown[];
      upTo: number;
      limit?: number;
      /**
       * Optional bitemporal "as of" timestamp (#86).  The preview's
       * source CTE filters observations to those valid at this
       * moment, so authors can compare a recipe's historical output
       * against today's.  Propagated through the chain unchanged.
       */
      at?: string;
    },
  ): Promise<{
    rowCount: number;
    truncated: boolean;
    sample: Array<{
      id: string | number | null;
      geometry: unknown;
      properties: Record<string, unknown>;
    }>;
    outputSchema: unknown[];
  }> {
    if (!args.source || typeof args.source.itemId !== 'string') {
      throw new BadRequestException(
        'preview.source.itemId is required',
      );
    }
    if (!Array.isArray(args.pipeline) || args.pipeline.length === 0) {
      throw new BadRequestException(
        'preview.pipeline must be a non-empty array of tool steps',
      );
    }
    // Use the same chain-walker enrichDerivedLayerData uses (#78) so
    // a derived_layer-as-source preview applies the same per-link
    // ACL check the save path does.
    const source = await this.assertReadableDerivedLayerChain(
      user,
      args.source.itemId,
    );
    // Coerce the inbound pipeline to the validator-friendly shape;
    // the validator inside DerivedLayersService.previewRecipe runs
    // each step's per-tool validate() so malformed entries surface
    // there as BadRequestException rather than a runtime crash.
    const pipeline = args.pipeline as Parameters<
      typeof this.derivedLayers.previewRecipe
    >[0]['pipeline'];
    const sourceArg = args.source as Parameters<
      typeof this.derivedLayers.previewRecipe
    >[0]['source'];
    return this.derivedLayers.previewRecipe({
      source: sourceArg,
      pipeline,
      sourceItem: source,
      upTo: args.upTo,
      limit: args.limit ?? 10,
      ...(typeof args.at === 'string' && args.at.length > 0
        ? { at: args.at }
        : {}),
    });
  }

  /**
   * Map items arrive from the wizard with the DEFAULT_MAP scaffold,
   * which uses an empty-string sentinel for `basemap`. Resolve the
   * sentinel to a real basemap item UUID so every saved map references
   * a renderable basemap from creation time. Preference order:
   *   1. The org's seeded `positron` basemap (matches the prior default).
   *   2. Any other seeded built-in basemap.
   *   3. Any basemap item visible to the org.
   * If none exists at all (which shouldn't happen since auth-sync seeds
   * on first login), leave the empty string in place; the canvas
   * gracefully falls back to the inline OSM raster.
   */
  private async resolveDefaultBasemap(
    orgId: string,
    data: unknown,
  ): Promise<unknown> {
    if (!data || typeof data !== 'object') return data;
    const obj = data as { basemap?: unknown };
    if (typeof obj.basemap !== 'string' || obj.basemap.length > 0) return data;

    const candidates = await this.prisma.item.findMany({
      where: { orgId, type: 'basemap', deletedAt: null },
      select: { id: true, data: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    if (candidates.length === 0) return data;

    const positron = candidates.find((c) => {
      const k = (c.data as { seededKey?: unknown } | null)?.seededKey;
      return k === 'positron';
    });
    const seeded = candidates.find((c) => {
      const k = (c.data as { seededKey?: unknown } | null)?.seededKey;
      return typeof k === 'string';
    });
    const pick = positron ?? seeded ?? candidates[0]!;
    return { ...obj, basemap: pick.id };
  }

  /**
   * Throws ForbiddenException if the caller can't edit the item.
   * Re-queries shares to make the check deterministic regardless of
   * whether the caller already has a stale share list.
   */
  async assertCanEdit(user: AuthUser, id: string): Promise<void> {
    const item = await this.get(user, id);
    const shares = await this.prisma.itemShare.findMany({
      where: { itemId: id },
    });
    if (!this.sharing.canEdit(user, item, shares)) {
      throw new ForbiddenException(
        'You do not have edit permission on this item',
      );
    }
  }

  async update(user: AuthUser, id: string, input: UpdateItemInput) {
    const item = await this.get(user, id);
    const shares = await this.prisma.itemShare.findMany({ where: { itemId: id } });
    if (!this.sharing.canEdit(user, item, shares)) {
      throw new ForbiddenException('You do not have edit permission on this item');
    }

    // Optimistic-concurrency precondition (opt-in). Clients that
    // read-modify-write a whole sub-document (the folder editor's
    // childItemIds is the canonical case) send the updatedAt they
    // loaded; if another tab or admin saved in between, we refuse
    // with 409 instead of silently reverting their change. Clients
    // that never send the field keep the old last-write-wins
    // behaviour, so nothing else breaks. Millisecond-exact compare:
    // updatedAt is timestamp(3) and every save bumps it, so equal
    // ms means "the row I read is the row I am replacing".
    if (
      input.expectedUpdatedAt !== undefined &&
      input.expectedUpdatedAt !== null
    ) {
      const expectedMs = Date.parse(input.expectedUpdatedAt);
      const actualMs = new Date(item.updatedAt).getTime();
      if (!Number.isFinite(expectedMs) || expectedMs !== actualMs) {
        throw new ConflictException(
          'This item changed since you loaded it. Refresh to see the latest version, then apply your change again.',
        );
      }
    }

    // Form-paired data_layer access invariant.  A form's "submissions"
    // data_layer (tagged `form-paired`) mirrors every submission row
    // including any PII the form collects.  If the paired layer's
    // access is allowed to drift looser than the parent form's, an
    // attacker who can read the form-pickle (or simply guesses the
    // layer id) can read every submission anonymously via the
    // public-features endpoint.  Refuse access widening on a paired
    // layer when the parent form is at a stricter tier.  The owner
    // can still widen the form first, then the layer; the inverse
    // (widen the layer alone) is what gets blocked.
    if (
      input.access !== undefined &&
      item.type === 'data_layer' &&
      (item.tags ?? []).includes('form-paired')
    ) {
      const parentForm = await this.prisma.item.findFirst({
        where: {
          orgId: item.orgId,
          type: 'form',
          deletedAt: null,
          data: { path: ['linkedLayerId'], equals: id },
        },
        select: { id: true, access: true, title: true },
      });
      if (parentForm) {
        const rank = (a: 'public' | 'org' | 'private'): number =>
          a === 'public' ? 2 : a === 'org' ? 1 : 0;
        const next = rank(input.access as 'public' | 'org' | 'private');
        const parent = rank(parentForm.access as 'public' | 'org' | 'private');
        if (next > parent) {
          throw new ForbiddenException(
            `Cannot set the paired submissions layer to '${input.access}' ` +
              `while the parent form '${parentForm.title}' is '${parentForm.access}'. ` +
              `Widen the form's access first, then the submissions layer.`,
          );
        }
      }
    }
    // Cycle detection for folder updates. If this update changes the
    // folder's childItemIds, walk every child's reachable graph and
    // fail the save if any descendant points back at this folder. See
    // docs/folders.md.
    if (item.type === 'folder' && input.data !== undefined) {
      const next = (input.data as { childItemIds?: unknown }).childItemIds;
      if (Array.isArray(next)) {
        await this.assertNoFolderCycle(
          id,
          (next as unknown[]).filter(
            (x): x is string => typeof x === 'string',
          ),
        );
      }
    }
    const prevLayers =
      item.type === 'data_layer' ? readV3Layers(item.data) : null;
    // If this update replaces the data blob, snapshot what was there
    // first so an admin can revert within the retention window.
    // Non-data updates (title / tags / access / thumbnail) skip the
    // snapshot since reverting those is trivially an edit away.
    if (input.data !== undefined && item.type === 'data_layer') {
      await this.snapshots.snapshot(id, user.id, 'pre-update');
    }
    // For derived_layer updates that touch the recipe, validate +
    // re-enrich (recomputes outputSchema and bbox) before persisting.
    // Metadata-only updates (title / tags / sharing) bypass this so
    // they stay cheap.
    let nextData: Prisma.InputJsonValue | undefined = input.data;
    if (input.data !== undefined && item.type === 'derived_layer') {
      nextData = (await this.enrichDerivedLayerData(
        user,
        input.data,
      )) as Prisma.InputJsonValue;
    }
    // For form items, preserve linkedLayerId / linkedLayerKey across
    // a `data` patch (#283 / #284). The form designer's save sends
    // the whole FormSchema as data, which would otherwise overwrite
    // the link to the paired data_layer that was set at create time
    // and break the submission mirror. The link is server-state, not
    // author-state: clients can't (and shouldn't) round-trip it.
    if (input.data !== undefined && item.type === 'form') {
      const prevData = (item.data ?? {}) as Record<string, unknown>;
      const incoming = (nextData ?? {}) as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...incoming };
      if (
        typeof prevData.linkedLayerId === 'string' &&
        typeof merged.linkedLayerId !== 'string'
      ) {
        merged.linkedLayerId = prevData.linkedLayerId;
      }
      if (
        typeof prevData.linkedLayerKey === 'string' &&
        typeof merged.linkedLayerKey !== 'string'
      ) {
        merged.linkedLayerKey = prevData.linkedLayerKey;
      }
      nextData = merged as Prisma.InputJsonValue;
    }

    // Round-trip footgun normalizer: any bare-MinIO URL pointing at
    // a private-prefix object (`item-file`, `item-tile-layer`,
    // `feature-attachment`) inside data_json gets rewritten to the
    // api-mediated download path on save.  Migration
    // `20260518230000_rewrite_storage_urls_to_api` (+ its nested
    // follow-up) did this once at the bucket-split rollover, but
    // any client whose React state was loaded BEFORE the migration
    // could post the bare URL back on save and re-poison the row
    // (the asset-picker, the file detail page, anything embedding
    // a denormalized storageUrl snapshot).  Re-applying the same
    // text-level regex here as a presave step makes the API the
    // authority, so no client cache can drift the value back.
    //
    // Public prefixes (`item-thumb`, `group-thumb`, `user-avatar`,
    // `org-hero`) are explicitly NOT matched: they keep their
    // direct MinIO URL because the bucket policy still allows
    // anonymous GET on those.
    if (nextData !== undefined) {
      const asText = JSON.stringify(nextData);
      const rewritten = asText.replace(
        /"https?:\/\/[^/"]+\/[^/"]+\/(item-file|item-tile-layer|feature-attachment)\/([0-9a-f-]+)"/g,
        '"/api/portal/storage/private/$1/$2"',
      );
      if (rewritten !== asText) {
        nextData = JSON.parse(rewritten) as Prisma.InputJsonValue;
      }
    }

    // Recompute the cached extent when the data blob changes; leave
    // it untouched on metadata-only edits so we don't churn the
    // index for no reason.
    const nextBbox =
      nextData !== undefined ? itemBbox(item.type, nextData) : null;
    const updated = await this.prisma.item.update({
      where: { id },
      data: {
        ...(input.title !== undefined && { title: input.title }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.tags !== undefined && { tags: input.tags }),
        ...(nextData !== undefined && { data: nextData }),
        ...(input.access !== undefined && { access: input.access }),
        // Belt-and-suspenders for the round-trip footgun: when a
        // client PATCHes thumbnailUrl as the synthesized SVG endpoint
        // path (the form may have read it from a GET response and
        // sent it back unchanged), treat it as null so the
        // synthesizer keeps generating a fresh URL with the latest
        // updatedAt cache-buster.  Without this, a save freezes the
        // URL and any subsequent design edit produces a card that
        // still serves the stale SVG.
        ...(input.thumbnailUrl !== undefined && {
          thumbnailUrl:
            typeof input.thumbnailUrl === 'string' &&
            /\/api\/portal\/items\/[^/]+\/thumbnail\.svg/.test(
              input.thumbnailUrl,
            )
              ? null
              : input.thumbnailUrl,
        }),
        // #66: thumbnailDesign updates re-render the SVG on the
        // next read; no extra side-effect needed here because the
        // synthesized thumbnailUrl is keyed on updatedAt which
        // Prisma is about to bump.  Prisma needs the JsonNull
        // sentinel to clear a nullable Json column; plain `null`
        // isn't accepted under exactOptionalPropertyTypes.
        ...(input.thumbnailDesign !== undefined && {
          thumbnailDesign:
            input.thumbnailDesign === null
              ? Prisma.JsonNull
              : input.thumbnailDesign,
        }),
        ...(input.license !== undefined && { license: input.license }),
        // #80: tier-level geo limits. Null clears, undefined leaves
        // unchanged. The columns are nullable in Prisma so passing
        // null directly is the right way to clear; we don't need a
        // separate disconnect path.
        ...(input.publicGeoBoundaryId !== undefined && {
          publicGeoBoundaryId: input.publicGeoBoundaryId,
        }),
        ...(input.orgGeoBoundaryId !== undefined && {
          orgGeoBoundaryId: input.orgGeoBoundaryId,
        }),
        ...(nextData !== undefined && { bbox: nextBbox ?? [] }),
      },
    });
    // Phase 2.5: schema edits are pure metadata now. Pre-engine,
    // this called dataLayerTables.reconcile to DROP tables for removed
    // layers and CREATE/ALTER tables for new ones. The engine
    // substrate keys observations by scope, so a layer that
    // disappears from the schema simply stops being read; no DDL
    // is needed and no data is lost. Phase 2.6 will sweep any
    // orphaned observation rows for layer keys that no item
    // references; for now they're cheap and harmless.
    const nextLayers =
      updated.type === 'data_layer' ? readV3Layers(updated.data) : null;
    // #230 Phase A: schema-change notification for live field
    // deployments. If the data_layer save dropped a layer or
    // changed a layer's geometryType, find every data_collection
    // that depends on this data_layer and notify the deployment
    // owner. Triggered after the row + table reconcile have both
    // landed so the notification represents an event the field
    // crew actually has to react to (their next sync will fail).
    if (
      prevLayers !== null &&
      nextLayers !== null &&
      (prevLayers.length > 0 || nextLayers.length > 0)
    ) {
      const breaks = computeSchemaBreaks(prevLayers, nextLayers);
      if (breaks.dropped.length > 0 || breaks.geometryChanged.length > 0) {
        // Fire-and-forget: a notify error must never roll back the
        // user-facing save. The field crew is going to hit the
        // broken sync regardless; better to let them save and
        // surface the warning best-effort than block the edit.
        void this.notifyDataCollectionSchemaBreak({
          dataLayerId: updated.id,
          dataLayerTitle: updated.title,
          changedBy: user,
          dropped: breaks.dropped,
          geometryChanged: breaks.geometryChanged,
        });
      }
    }
    return updated;
  }

  /**
   * Schema-break notification fan-out (#230 Phase A). Walks the
   * dependents graph from the changed data_layer to every
   * data_collection that transitively references it, and notifies
   * each deployment's owner. Recipients on the offline-area side
   * (per-user offline-area mirrors) are a Phase A.5 extension --
   * for v1 we tell the deployment owner so they can warn their
   * field crew themselves.
   */
  private async notifyDataCollectionSchemaBreak(args: {
    dataLayerId: string;
    dataLayerTitle: string;
    changedBy: AuthUser;
    dropped: string[];
    geometryChanged: string[];
  }): Promise<void> {
    try {
      // We can't go through this.listDependents() because it gates
      // on visibility-for-the-caller; the schema-break notify needs
      // to fan out to deployments the changing admin may not own.
      // Instead, do the same BFS walk against every referencer
      // type in the org, scoped by the changed item's orgId.
      const target = await this.prisma.item.findUnique({
        where: { id: args.dataLayerId },
        select: { orgId: true, title: true },
      });
      if (!target) return;
      // Pull every potentially-referencing item in this org. The
      // shape mirrors listDependents() but skips its visibility
      // re-query. REFERENCER_TYPES includes data_collection so
      // we'll hit them in the BFS reverse index.
      const referencers = await this.prisma.item.findMany({
        where: {
          orgId: target.orgId,
          type: { in: REFERENCER_TYPES },
          deletedAt: null,
        },
        select: {
          id: true,
          type: true,
          title: true,
          ownerId: true,
          data: true,
          // #80: include tier-level boundary refs so a tier-clipped
          // data_layer's "data_collection that depends on it" walk
          // doesn't silently miss edges that go through the boundary.
          publicGeoBoundaryId: true,
          orgGeoBoundaryId: true,
        },
      });
      const reverse = new Map<string, string[]>();
      const byId = new Map<string, (typeof referencers)[number]>();
      for (const r of referencers) {
        byId.set(r.id, r);
        const deps = extractDependencies(r);
        for (const d of deps.itemIds) {
          const arr = reverse.get(d) ?? [];
          arr.push(r.id);
          reverse.set(d, arr);
        }
      }
      // BFS outward from the data_layer id. Collect every
      // data_collection reachable (including transitively
      // through maps). Cycle-guarded by `seen`.
      const seen = new Set<string>();
      const frontier: string[] = [args.dataLayerId];
      const dataCollections: Array<(typeof referencers)[number]> = [];
      while (frontier.length > 0) {
        const next = frontier.shift()!;
        const ancestors = reverse.get(next) ?? [];
        for (const a of ancestors) {
          if (seen.has(a)) continue;
          seen.add(a);
          const item = byId.get(a);
          if (!item) continue;
          if (item.type === 'data_collection') {
            dataCollections.push(item);
          }
          frontier.push(a);
        }
      }
      if (dataCollections.length === 0) return;
      // Display name of the admin who made the change. Falls back
      // to "An admin" so the email never reads "undefined just
      // changed...".
      const changedRow = await this.prisma.user.findUnique({
        where: { id: args.changedBy.id },
        select: { fullName: true, username: true },
      });
      const changedByName =
        changedRow?.fullName || changedRow?.username || 'An admin';
      // For each affected deployment we notify two cohorts:
      //   1. The deployment owner (so authors hear about it even
      //      if no field crew has reported in yet).
      //   2. Every user whose field_queue_manifest currently
      //      references this dataCollectionId. Those are the
      //      people whose next sync is about to fail loudly --
      //      reaching them directly is the point of this whole
      //      flow. Dedupe owner-vs-downloader by (userId, dcId).
      // We do per-deployment so the email payload still names the
      // specific data_collection. A user who has 5 offline areas
      // gets up to 5 emails; that's worse than one digest, but
      // worth it for v1 because each email tells them which area
      // to rebuild.
      for (const dc of dataCollections) {
        // Postgres JSONB containment to find devices with this
        // deployment in their manifest. The manifest JSON is an
        // array of { dataCollectionId, ... } objects so the
        // containment predicate is a single-element array with
        // the matching id.
        const downloaders = await this.prisma.$queryRaw<
          Array<{ user_id: string }>
        >(Prisma.sql`
          SELECT DISTINCT user_id
          FROM field_queue_manifest
          WHERE manifest @> ${Prisma.sql`${JSON.stringify([
            { dataCollectionId: dc.id },
          ])}::jsonb`}
        `);
        const recipients = new Set<string>([dc.ownerId]);
        for (const row of downloaders) recipients.add(row.user_id);
        for (const userId of recipients) {
          await this.notifications.notify(
            userId,
            'data_collection_schema_break',
            {
              dataCollectionId: dc.id,
              dataCollectionTitle: dc.title,
              dataLayerId: args.dataLayerId,
              dataLayerTitle: args.dataLayerTitle,
              changedByName,
              droppedLayerKeys: args.dropped,
              geometryChangedLayerKeys: args.geometryChanged,
            },
          );
        }
      }
    } catch (err) {
      // Same swallow rationale as the editor / data_collection
      // notify helpers: notify errors are non-fatal because the
      // schema change already landed.
      // eslint-disable-next-line no-console
      console.warn(
        `data_collection_schema_break notify failed: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  /**
   * Soft-delete: mark the item as trashed. The row (and its shares) stays
   * in the database so it can be restored. A scheduled job purges rows
   * whose deletedAt is older than the retention window (see
   * docs/soft-delete.md).
   *
   * For folder items (#156), a non-empty cascade set requires
   * opts.cascade=true. Without it, the call refuses with a 409 that
   * carries the cascade preview so the frontend can show the user a
   * list of subfolders that would be soft-deleted alongside the
   * parent. With cascade=true, the parent and every orphan-only
   * subfolder soft-delete together in a single transaction, stamped
   * with a shared deletedCohortId so restore() can bring them back
   * as a group later.
   *
   * Non-folder items in the parent are NOT cascaded; per the folder
   * design (docs/folders.md), folder membership is a view, not an
   * authoritative reference, so a data_layer / map / file in the
   * trashed folder simply loses the folder reference once the folder
   * is purged. The soft-delete itself doesn't touch those rows.
   */
  async remove(
    user: AuthUser,
    id: string,
    opts: { cascade?: boolean } = {},
  ) {
    const item = await this.get(user, id);
    if (!this.sharing.canAdmin(user, item)) {
      throw new ForbiddenException('Only the owner or an org admin can delete an item');
    }

    let cascadeFolderIds: string[] = [];
    if (item.type === 'folder') {
      const preview = await this.previewFolderDeleteCascade(user, id);
      if (preview.folders.length > 0) {
        if (!opts.cascade) {
          // 409: the request would have side effects the caller
          // didn't acknowledge. Frontend reads the response body's
          // `cascade` field to populate its confirmation dialog,
          // then retries with cascade=true.
          throw new ConflictException({
            message:
              'This folder contains subfolders that would be orphaned. Acknowledge the cascade by retrying with ?cascade=true.',
            cascade: preview,
          });
        }
        cascadeFolderIds = preview.folders.map((f) => f.id);
      }
    }

    const now = new Date();
    if (cascadeFolderIds.length === 0) {
      await this.prisma.item.update({
        where: { id },
        data: { deletedAt: now },
      });
      return;
    }
    // Cascade: one cohort UUID stamped on every row so restore can
    // pull them back together.
    const cohortId = randomUUID();
    await this.prisma.item.updateMany({
      where: { id: { in: [id, ...cascadeFolderIds] } },
      data: { deletedAt: now, deletedCohortId: cohortId },
    });
  }

  /**
   * Compute the set of subfolders that would be cascade-deleted if
   * the given folder were trashed (#156).
   *
   * Algorithm:
   *
   *   - Load every non-trashed folder in the caller's org. For each,
   *     read its `childItemIds` and build a parent map keyed by
   *     child UUID.
   *   - BFS from the root folder. For each visited folder, examine
   *     its childItemIds:
   *       * if the child is itself a folder AND every non-trashed
   *         parent of that folder is already in the cascade set,
   *         add it and continue the BFS down into it.
   *       * if the child is a folder but has a parent outside the
   *         cascade set, skip (it survives because it's still filed
   *         under another folder).
   *       * if the child is not a folder, increment unlinkedItemCount.
   *
   * The root folder itself is intentionally excluded from the
   * returned `folders` list -- the caller already knows it's being
   * deleted. The list contains only the subfolders the user wouldn't
   * otherwise have noticed are about to disappear.
   *
   * Returns `{ folders: [], unlinkedItemCount: 0 }` for non-folder
   * items so the call site can treat the preview as a no-op shape
   * regardless of item type.
   */
  async previewFolderDeleteCascade(
    user: AuthUser,
    id: string,
  ): Promise<FolderDeleteCascadePreview> {
    const item = await this.get(user, id);
    if (item.type !== 'folder') {
      return { folders: [], unlinkedItemCount: 0 };
    }

    // Load every non-trashed folder in the org so we can resolve
    // child-of relationships in memory. Org-scoped because folder
    // membership never crosses orgs (every item has exactly one
    // orgId). For typical org folder counts (dozens to a few
    // hundred) this is cheap; if we ever hit five-figure folder
    // counts per org this becomes a recursive CTE in PostgreSQL.
    const allFolders = await this.prisma.item.findMany({
      where: {
        orgId: item.orgId,
        type: 'folder',
        deletedAt: null,
      },
      select: { id: true, title: true, data: true },
    });

    return computeFolderCascade(
      id,
      allFolders.map((f) => {
        const data = f.data as unknown as {
          childItemIds?: unknown;
          smartQuery?: unknown;
        } | null;
        return {
          id: f.id,
          title: f.title,
          // Smart folders compute membership from a query, not from
          // childItemIds, so they never "own" their displayed
          // contents and a delete cannot orphan anything via them.
          // Treat as empty for cascade purposes.
          childItemIds: data?.smartQuery
            ? []
            : Array.isArray(data?.childItemIds)
              ? (data.childItemIds as unknown[]).filter(
                  (x): x is string => typeof x === 'string',
                )
              : [],
        };
      }),
    );
  }

  /**
   * Restore a trashed item. Only the owner or an org admin can
   * restore. When the trashed row carries a deletedCohortId (#156),
   * every other row in the cohort restores in the same transaction,
   * so a parent folder doesn't come back pointing at still-trashed
   * subfolders. Rows in the cohort that the caller cannot admin
   * are silently skipped; partial restore is preferable to a 403.
   */
  async restore(user: AuthUser, id: string) {
    const item = await this.get(user, id, { includeTrashed: true });
    if (!item.deletedAt) {
      // Not in the trash, nothing to do, and returning 200 would
      // hide a client bug. 400 is more informative than silently no-op.
      throw new BadRequestException('Item is not in the trash');
    }
    if (!this.sharing.canAdmin(user, item)) {
      throw new ForbiddenException('Only the owner or an org admin can restore an item');
    }
    if (!item.deletedCohortId) {
      return this.prisma.item.update({
        where: { id },
        data: { deletedAt: null },
      });
    }

    // Cohort restore. Pull every other still-trashed row in the
    // cohort, filter to ones the caller can admin, restore them
    // alongside the target in a single updateMany.
    const cohort = await this.prisma.item.findMany({
      where: {
        deletedCohortId: item.deletedCohortId,
        deletedAt: { not: null },
      },
    });
    const restoreIds = cohort
      .filter((m) => this.sharing.canAdmin(user, m))
      .map((m) => m.id);
    // The target is always in restoreIds because canAdmin already
    // passed above; updateMany also clears deletedCohortId so a
    // future redelete starts a fresh cohort.
    await this.prisma.item.updateMany({
      where: { id: { in: restoreIds } },
      data: { deletedAt: null, deletedCohortId: null },
    });
    // Return the originally-requested row in its restored state so
    // the caller sees the same shape `update` would have returned.
    return this.prisma.item.findUnique({ where: { id } });
  }

  /**
   * Permanently delete a trashed item. Cascades to item_share rows. If
   * the item is a v2 data_layer (storageType === 'postgis'), also
   * drops the backing PostGIS table so we don't leak orphaned tables.
   */
  async purge(user: AuthUser, id: string) {
    const item = await this.get(user, id, { includeTrashed: true });
    if (!item.deletedAt) {
      throw new BadRequestException('Item must be in the trash before it can be purged');
    }
    if (!this.sharing.canAdmin(user, item)) {
      throw new ForbiddenException('Only the owner or an org admin can purge an item');
    }
    await this.tearDownItemBackingStorage(item.id, item.type, item.data);
    // Cascade folder cleanup: any folder whose data.childItemIds
    // references the now-purged UUID gets that UUID spliced out.
    // Soft-delete deliberately does NOT do this (so trash restoration
    // restores folder membership too); cleanup only runs at hard-delete
    // when the item is gone for good. See docs/folders.md.
    await this.spliceFromFolders(id);
    await this.prisma.item.delete({ where: { id } });
  }

  /**
   * Cross-storage cleanup that runs when an item is permanently
   * deleted. Public so the nightly TrashPurgeService can invoke it
   * for each row before its bulk deleteMany; until #115 P11 the
   * TrashPurgeService bypassed this and just deleted the item row,
   * leaving observations + MinIO objects to accumulate as orphans.
   *
   * Handles, by item type:
   *
   *   - v3 data_layer: DELETE FROM observation WHERE scope LIKE
   *     'data_layer:<itemId>:%'. The partition router targets only
   *     the actual partitions; one statement, no per-layer fan-out.
   *   - legacy v2 data_layer: DROP the per-item fs_ table.
   *   - file: storage.deleteObject(storageKey) so the MinIO object
   *     doesn't leak. Best-effort -- a missing object is fine; we
   *     swallow ENOENT so a half-uploaded item still purges.
   *
   * Other item types (map, web_app, dashboard, ...) carry only
   * metadata in item.data and don't need backing-storage cleanup.
   */
  async tearDownItemBackingStorage(
    itemId: string,
    itemType: ItemType,
    itemData: unknown,
  ): Promise<void> {
    if (itemType === 'data_layer') {
      const data = itemData as
        | { version?: number; storageType?: string }
        | null;
      if (data?.version === 3) {
        // Engine-pivot layout: features live in `observation` keyed
        // by scope. Wipe every scope under this item id in one
        // statement; pg_partman partition routing keeps it cheap.
        await this.prisma.$executeRaw`
          DELETE FROM observation
          WHERE scope LIKE ${`data_layer:${itemId}:%`}
        `;
      } else if (data?.storageType === 'postgis') {
        // v2 legacy: per-item table. Drop it so the storage shrinks
        // immediately (DROP TABLE returns disk faster than DELETE).
        const tbl = `fs_${itemId.replace(/-/g, '')}`;
        await this.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${tbl}"`);
      }
    } else if (
      itemType === 'file' ||
      itemType === 'tile_layer' ||
      itemType === 'point_cloud'
    ) {
      // file + tile_layer + point_cloud all store a single MinIO
      // object keyed by data.storageKey; cleanup is identical. Best-effort: a
      // missing key, MinIO down, or transient permission error
      // shouldn't block the item-row delete. Orphan accounting
      // on the storage card surfaces any leaked object.
      const data = itemData as { storageKey?: string } | null;
      const key = data?.storageKey;
      if (typeof key === 'string' && key.length > 0) {
        try {
          await this.storage.deleteObject(key);
        } catch (err) {
          void err;
        }
      }
    }
  }

  /**
   * Refuse a folder update that would introduce a cycle. Walks the
   * folder graph breadth-first starting from every UUID in the
   * proposed `childItemIds`; if any reachable folder's id matches
   * `selfId`, the save would create a cycle (folder A references B
   * which references A). Non-folder children are leaves and stop the
   * walk early. See docs/folders.md.
   */
  private async assertNoFolderCycle(
    selfId: string,
    nextChildItemIds: string[],
  ): Promise<void> {
    if (nextChildItemIds.length === 0) return;
    if (nextChildItemIds.includes(selfId)) {
      throw new BadRequestException(
        'A folder cannot contain itself.',
      );
    }
    const visited = new Set<string>();
    let frontier = Array.from(new Set(nextChildItemIds));
    while (frontier.length > 0) {
      const rows = await this.prisma.item.findMany({
        where: { id: { in: frontier }, type: 'folder', deletedAt: null },
        select: { id: true, data: true },
      });
      const nextFrontier: string[] = [];
      for (const row of rows) {
        if (visited.has(row.id)) continue;
        visited.add(row.id);
        const data = row.data as { childItemIds?: unknown } | null;
        if (!data || !Array.isArray(data.childItemIds)) continue;
        for (const child of data.childItemIds) {
          if (typeof child !== 'string') continue;
          if (child === selfId) {
            throw new BadRequestException(
              'This change would create a folder cycle.',
            );
          }
          if (!visited.has(child)) nextFrontier.push(child);
        }
      }
      frontier = nextFrontier;
    }
  }

  /**
   * Remove a now-purged item id from every folder's childItemIds list.
   * Runs inside the purge path; not exposed publicly. Uses a JSONB
   * filter to find candidate folders so we don't have to load every
   * folder in the org. See docs/folders.md.
   */
  private async spliceFromFolders(deletedItemId: string): Promise<void> {
    const candidates = await this.prisma.$queryRaw<
      Array<{ id: string; data_json: unknown }>
    >`
      SELECT id, data_json
      FROM "item"
      WHERE type = 'folder'::"ItemType"
        AND data_json @> jsonb_build_object('childItemIds', jsonb_build_array(${deletedItemId}::text))
    `;
    for (const row of candidates) {
      const data = row.data_json as { version?: number; childItemIds?: unknown } | null;
      if (!data || !Array.isArray(data.childItemIds)) continue;
      const next = (data.childItemIds as unknown[]).filter(
        (id) => id !== deletedItemId,
      );
      if (next.length === data.childItemIds.length) continue;
      await this.prisma.item.update({
        where: { id: row.id },
        data: { data: { ...data, childItemIds: next } as Prisma.InputJsonValue },
      });
    }
  }

  /**
   * Return the GeoJSON FeatureCollection for a data_layer item.
   * Handles both v1 (inline JSON) and v2 (PostGIS table) storage transparently.
   *
   * Accepts an optional bbox filter for v2; v1 always returns all features.
   * Optional `boundaryClipId` (#34) names a geo_boundary item whose
   * polygon clips the result set; honored on both v1 (in-memory clip
   * via bbox prefilter; full polygon intersect skipped because v1 is
   * inline JSON without PostGIS) and v2 (ST_Intersects in SQL).
   */
  async getGeoJson(
    user: AuthUser,
    id: string,
    opts: {
      bbox?: [number, number, number, number];
      at?: string;
      boundaryClipId?: string;
    } = {},
  ): Promise<{ type: 'FeatureCollection'; features: unknown[] }> {
    const item = await this.get(user, id);

    if (item.type === 'derived_layer') {
      // Resolve and authorize the source data layer here so the
      // derived-layers service stays one-directional (no SharingService
      // dependency). A source that's missing, trashed, or out of
      // reach for the caller produces an empty FeatureCollection
      // rather than throwing, so a momentary inconsistency degrades
      // gracefully on the map.
      const data = item.data as { source?: { itemId?: string } } | null;
      const sourceId = data?.source?.itemId;
      if (typeof sourceId !== 'string' || sourceId.length === 0) {
        return { type: 'FeatureCollection', features: [] };
      }
      const source = await this.prisma.item.findUnique({
        where: { id: sourceId },
        include: { shares: true },
      });
      if (
        !source ||
        source.deletedAt !== null ||
        !this.sharing.canRead(user, source, source.shares)
      ) {
        return { type: 'FeatureCollection', features: [] };
      }
      return this.derivedLayers.getGeoJson(item, source, opts);
    }

    if (item.type !== 'data_layer') {
      return { type: 'FeatureCollection', features: [] };
    }

    const data = item.data as {
      storageType?: string;
      version?: number;
      data?: unknown;
      layers?: Array<{
        id: string;
        geometryType?: string | null;
      }>;
    } | null;

    // Resolve the boundary clip once up front so both v1 and v2
    // branches can use it. Bypasses per-user authz on the boundary
    // (see DataLayerFeaturesController.resolveBoundaryGeometry for the
    // rationale).
    let boundaryGeom: unknown | null = null;
    if (opts.boundaryClipId) {
      const row = await this.prisma.item.findFirst({
        where: {
          id: opts.boundaryClipId,
          type: 'geo_boundary',
          deletedAt: null,
        },
        select: { data: true },
      });
      const g = (row?.data as { geometry?: unknown } | null)?.geometry;
      if (g && typeof g === 'object') boundaryGeom = g;
    }

    if (data?.storageType === 'postgis') {
      // v2 + v3 share the column shape (gid, global_id, geom,
      // properties, valid_*, created_*, edited_*) so the SELECT
      // below works for either. They differ only in the table name:
      //
      //   v2: fs_<itemId>             (single table per item)
      //   v3: fs_<itemId>_<layerKey>  (one table per sublayer)
      //
      // The legacy /items/:id/geojson endpoint is item-level and
      // doesn't carry a sublayer key, so for v3 items we fall back
      // to the first spatial sublayer (#194). Saved maps that
      // predate the per-sublayer source URL (#189) still hit this
      // path and get a sensible default; authors who want a
      // specific sublayer can re-add the layer from the dialog
      // (which now stamps layerKey) or wait for a backfill pass.
      // v3 items with zero spatial sublayers (event-tracking-only
      // deployments) return an empty FC.
      let tbl: string;
      if (data.version === 3 && Array.isArray(data.layers)) {
        const firstSpatial = (
          data.layers as Array<{ id?: string; geometryType?: string | null }>
        ).find((l) => l.geometryType !== null && l.geometryType !== undefined);
        if (!firstSpatial?.id) {
          return { type: 'FeatureCollection', features: [] };
        }
        tbl = `fs_${id.replace(/-/g, '')}_${firstSpatial.id}`;
      } else {
        tbl = `fs_${id.replace(/-/g, '')}`;
      }
      const params: unknown[] = [];
      const conditions: string[] = [];

      if (opts.at) {
        const ts = new Date(opts.at);
        if (!isNaN(ts.getTime())) {
          params.push(ts.toISOString());
          const p = params.length;
          conditions.push(
            `valid_from <= $${p}::timestamptz AND (valid_to IS NULL OR valid_to > $${p}::timestamptz)`,
          );
        }
      } else {
        conditions.push('valid_to IS NULL');
      }

      if (opts.bbox) {
        const [minX, minY, maxX, maxY] = opts.bbox;
        params.push(minX, minY, maxX, maxY);
        const b = params.length;
        conditions.push(
          `geom IS NOT NULL AND ST_Intersects(geom, ST_MakeEnvelope($${b - 3}, $${b - 2}, $${b - 1}, $${b}, 4326))`,
        );
      }

      if (boundaryGeom) {
        // Layer-level boundary clip (#34). Same shape the v3 service
        // emits: ST_GeomFromGeoJSON over a JSON-encoded GeoJSON
        // geometry, with explicit SRID 4326 to match the column.
        params.push(JSON.stringify(boundaryGeom));
        const b = params.length;
        conditions.push(
          `geom IS NOT NULL AND ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON($${b}::text), 4326))`,
        );
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      // Editor-tracking columns are inlined as `_created_by`,
      // `_created_at`, `_edited_by`, `_edited_at` on each feature's
      // properties so popups, the attribute table, and any custom
      // template UI surface them without an extra round-trip. The
      // underscore prefix marks them as system metadata (the popup
      // 'all' renderer skips underscore-prefixed keys by default;
      // the dedicated metadata footer formats them properly). See
      // docs/folders.md and the editor-tracking task #39.
      type RawRow = {
        global_id: string;
        geom: string | null;
        properties: Record<string, unknown>;
        created_by: string | null;
        created_at: Date | string | null;
        edited_by: string | null;
        edited_at: Date | string | null;
      };
      const rows = await this.prisma.$queryRawUnsafe<RawRow[]>(
        `SELECT global_id,
                ST_AsGeoJSON(geom) AS geom,
                properties,
                created_by,
                created_at,
                edited_by,
                edited_at
           FROM "${tbl}"
          ${where}
          ORDER BY gid
          LIMIT 10000`,
        ...params,
      );

      return {
        type: 'FeatureCollection',
        features: rows.map((r) => ({
          type: 'Feature',
          id: r.global_id,
          geometry: r.geom ? JSON.parse(r.geom) : null,
          properties: {
            ...r.properties,
            _created_by: r.created_by,
            _created_at:
              r.created_at instanceof Date
                ? r.created_at.toISOString()
                : r.created_at,
            _edited_by: r.edited_by,
            _edited_at:
              r.edited_at instanceof Date
                ? r.edited_at.toISOString()
                : r.edited_at,
          },
        })),
      };
    }

    // v1: inline GeoJSON in item.data.data
    const fc = data?.data;
    if (
      !fc ||
      typeof fc !== 'object' ||
      (fc as { type?: string }).type !== 'FeatureCollection'
    ) {
      return { type: 'FeatureCollection', features: [] };
    }
    return fc as { type: 'FeatureCollection'; features: unknown[] };
  }

  /**
   * Change the owner of an item. Gated to the current owner + org
   * admins. Optionally adds a `view` share for the previous owner so
   * they don't lose access entirely: handy for "I'm leaving the
   * team, please take this from me" and audit-friendly reassigns.
   */
  async reassignOwner(
    user: AuthUser,
    id: string,
    input: {
      newOwnerId: string;
      keepPreviousOwnerAccess?: 'view' | 'download' | 'edit' | 'admin' | null;
    },
  ) {
    const item = await this.get(user, id);
    if (!this.sharing.canAdmin(user, item)) {
      throw new ForbiddenException(
        'Only the current owner or an org admin can reassign ownership',
      );
    }
    if (input.newOwnerId === item.ownerId) {
      return item; // no-op: already owned by the target user
    }
    // Target user must exist AND be in the same org. Cross-org
    // reassignment is out of scope: that would leak content across
    // org boundaries.
    const newOwner = await this.prisma.user.findUnique({
      where: { id: input.newOwnerId },
      select: { id: true, orgId: true, username: true, fullName: true },
    });
    if (!newOwner) {
      throw new BadRequestException('Unknown user');
    }
    if (newOwner.orgId !== item.orgId) {
      throw new BadRequestException(
        'Cannot reassign an item to a user in a different organization',
      );
    }

    const prevOwnerId = item.ownerId;

    // Transaction: update ownership + optionally add a share for the
    // previous owner, in one round-trip. The share is skipped when
    // keepPreviousOwnerAccess is null / undefined or when the
    // previous owner is the caller's own account (they already
    // carry admin through org role if relevant).
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.item.update({
        where: { id },
        data: { ownerId: input.newOwnerId },
      });
      if (input.keepPreviousOwnerAccess) {
        await tx.itemShare.upsert({
          where: {
            itemId_principalType_principalId: {
              itemId: id,
              principalType: 'user',
              principalId: prevOwnerId,
            },
          },
          update: { permission: input.keepPreviousOwnerAccess },
          create: {
            itemId: id,
            principalType: 'user',
            principalId: prevOwnerId,
            permission: input.keepPreviousOwnerAccess,
          },
        });
      }
      return updated;
    });
  }

  /**
   * Count how many items a given user owns. Used by the admin-delete
   * flow to decide whether to force a reassignment step. Respects the
   * caller's org: the count only includes items in the caller's org
   * so admins don't see cross-org bleed.
   */
  async ownedItemCount(
    user: AuthUser,
    targetUserId: string,
  ): Promise<number> {
    return this.prisma.item.count({
      where: {
        ownerId: targetUserId,
        orgId: user.orgId,
        deletedAt: null,
      },
    });
  }

  /**
   * Bulk reassignment. Applies reassignOwner() across many items in
   * a single transaction, stopping on the first failure. Useful for
   * the "delete this user -> move their stuff first" flow and for
   * bulk-select in the items list.
   */
  async bulkReassignOwner(
    user: AuthUser,
    input: {
      itemIds: string[];
      newOwnerId: string;
      keepPreviousOwnerAccess?: 'view' | 'download' | 'edit' | 'admin' | null;
    },
  ): Promise<{ reassigned: number }> {
    let reassigned = 0;
    for (const id of input.itemIds) {
      const patch: {
        newOwnerId: string;
        keepPreviousOwnerAccess?: 'view' | 'download' | 'edit' | 'admin' | null;
      } = { newOwnerId: input.newOwnerId };
      if (input.keepPreviousOwnerAccess !== undefined) {
        patch.keepPreviousOwnerAccess = input.keepPreviousOwnerAccess;
      }
      await this.reassignOwner(user, id, patch);
      reassigned += 1;
    }
    return { reassigned };
  }

  async share(user: AuthUser, id: string, input: ShareItemInput) {
    const item = await this.get(user, id);
    if (!this.sharing.canAdmin(user, item)) {
      throw new ForbiddenException('Only the owner or an org admin can change sharing');
    }
    await this.assertPrincipalExists(input.principalType, input.principalId);
    // Build the update payload conditionally so an undefined field
    // doesn't overwrite a previously-set value. `null` is the explicit
    // "clear" signal and DOES pass through to Prisma.
    //
    // geoLimit and geoBoundaryId are mutually exclusive: setting one
    // to a non-null value clears the other on the same update so the
    // share never carries a stale partner column. Either field can be
    // explicitly cleared with `null` independently.
    const update: Record<string, unknown> = {
      permission: input.permission ?? 'view',
    };
    if (input.geoBoundaryId !== undefined) {
      update.geoBoundaryId = input.geoBoundaryId;
      if (input.geoBoundaryId !== null) update.geoLimit = null;
    }
    if (input.geoLimit !== undefined) {
      update.geoLimit = input.geoLimit;
      if (input.geoLimit !== null) update.geoBoundaryId = null;
    }
    if (input.rowScope !== undefined) {
      update.rowScope = input.rowScope;
    }
    if (input.expiresAt !== undefined) {
      // null clears, anything else (Date or ISO string) sets.
      // Prisma accepts either; coerce a string here so callers
      // sending JSON don't have to construct a Date.
      update.expiresAt =
        input.expiresAt === null ? null : new Date(input.expiresAt);
    }
    const create: Record<string, unknown> = {
      itemId: id,
      principalType: input.principalType,
      principalId: input.principalId,
      permission: input.permission ?? 'view',
    };
    if (input.geoLimit !== undefined && input.geoLimit !== null) {
      create.geoLimit = input.geoLimit;
    }
    if (
      input.geoBoundaryId !== undefined &&
      input.geoBoundaryId !== null
    ) {
      create.geoBoundaryId = input.geoBoundaryId;
    }
    if (input.rowScope !== undefined) {
      create.rowScope = input.rowScope;
    }
    if (input.expiresAt !== undefined && input.expiresAt !== null) {
      create.expiresAt = new Date(input.expiresAt);
    }
    // Track whether this is a NEW share (vs an updated existing
    // one) so we only notify on first creation. An author tweaking
    // a permission or expiry on an existing share shouldn't spam
    // the recipient with another email.
    const existing = await this.prisma.itemShare.findUnique({
      where: {
        itemId_principalType_principalId: {
          itemId: id,
          principalType: input.principalType,
          principalId: input.principalId,
        },
      },
      select: { itemId: true },
    });
    const result = await this.prisma.itemShare.upsert({
      where: {
        itemId_principalType_principalId: {
          itemId: id,
          principalType: input.principalType,
          principalId: input.principalId,
        },
      },
      update: update as Prisma.ItemShareUpdateInput,
      create: create as Prisma.ItemShareCreateInput,
    });

    // First-time share fires a share_created notification to the
    // affected user(s). For a user principal that's one row; for
    // a group it's every member. Resolved here rather than inside
    // NotificationsService so the fan-out is visible at the call
    // site -- helps when reasoning about why one share triggers N
    // emails. The author's own user id is filtered out below to
    // avoid the noise of "you shared something with yourself" when
    // an author shares with a group they're a member of.
    if (!existing) {
      const recipientIds = await this.resolveShareRecipientIds(
        input.principalType,
        input.principalId,
      );
      const sharer = await this.prisma.user.findUnique({
        where: { id: user.id },
        select: { fullName: true, username: true },
      });
      const sharerName =
        sharer?.fullName || sharer?.username || 'Someone';
      const payload = {
        itemId: item.id,
        itemTitle: item.title,
        itemType: item.type,
        permission: input.permission ?? 'view',
        sharedByName: sharerName,
        ...(input.expiresAt
          ? {
              expiresAt:
                typeof input.expiresAt === 'string'
                  ? input.expiresAt
                  : input.expiresAt.toISOString(),
            }
          : {}),
      };
      // Fire-and-forget: never block the share response on
      // notification enqueue. NotificationsService also catches
      // its own errors as a defence in depth.
      void this.notifications.notifyMany(
        recipientIds.filter((rid) => rid !== user.id),
        'share_created',
        payload,
      );
    }
    return result;
  }

  /**
   * Resolve the user ids that need to be notified for a share
   * targeting a given principal. User shares notify just that
   * user; group shares fan out to every member of the group.
   * Group memberships at notify-time -- a member added later
   * doesn't retroactively get a "you got shared on this" email,
   * which matches the user-visible model that sharing happens
   * once, not continuously.
   */
  private async resolveShareRecipientIds(
    principalType: PrincipalType,
    principalId: string,
  ): Promise<string[]> {
    if (principalType === 'user') return [principalId];
    const members = await this.prisma.groupMember.findMany({
      where: { groupId: principalId },
      select: { userId: true },
    });
    return members.map((m) => m.userId);
  }

  async unshare(user: AuthUser, id: string, input: ShareItemInput) {
    const item = await this.get(user, id);
    if (!this.sharing.canAdmin(user, item)) {
      throw new ForbiddenException('Only the owner or an org admin can change sharing');
    }
    await this.prisma.itemShare.delete({
      where: {
        itemId_principalType_principalId: {
          itemId: id,
          principalType: input.principalType,
          principalId: input.principalId,
        },
      },
    });
  }

  private async assertPrincipalExists(type: PrincipalType, id: string) {
    if (type === 'user') {
      const hit = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
      if (!hit) throw new BadRequestException('Unknown user principal');
    } else if (type === 'group') {
      // A trashed group should not be a valid share target; treat it as
      // unknown so clients can't create new references to something that
      // will disappear on purge.
      const hit = await this.prisma.group.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (!hit) throw new BadRequestException('Unknown group principal');
    }
  }

  // ---------------------------------------------------------------
  // Dependency tracking: "Used by" / "Depends on"
  // ---------------------------------------------------------------

  /**
   * Return the items that THIS item references (forward edges). For a
   * map, that's each layer's data_layer / arcgis_service.
   *
   * Results are scoped to items the caller can see: if the map
   * references something private that the caller isn't shared on, it
   * simply doesn't appear in the list (instead of 403'ing, which
   * would leak the existence of a hidden dependency).
   */
  /**
   * Resolve a folder's children into the visible item rows. Drops:
   *  - items the caller cannot see (per-item authz, including org /
   *    public scope and per-share grants),
   *  - items in the trash (deletedAt set),
   *  - dangling references to items that no longer exist.
   * Returns the surviving items in `childItemIds` order; the API
   * response is therefore identical in shape to a regular items list
   * (same `include` projection) so the client can reuse its existing
   * card / row components. See docs/folders.md.
   */
  /**
   * Resolve a smart folder's saved query to a list of items the
   * caller can see (#38). Translates the FolderSmartQuery shape
   * into the opts list() expects, then invokes list() so all the
   * authz/inheritance/visibility logic stays in one place. The
   * `lite` mode is left off so the wire shape matches a regular
   * static-folder response (full Item rows, not slim projections).
   *
   * `limit` is clamped server-side to 1000 so a smart folder set
   * to "everything" doesn't accidentally render a giant grid.
   */
  private async resolveSmartFolder(
    user: AuthUser,
    rawQuery: unknown,
  ): Promise<unknown> {
    const q = (rawQuery ?? {}) as {
      type?: unknown;
      q?: unknown;
      searchFields?: unknown;
      ownerId?: unknown;
      bbox?: unknown;
      bufferKm?: unknown;
      limit?: unknown;
    };
    const opts: {
      type?: ItemType | ItemType[];
      q?: string;
      searchFields?: Array<'title' | 'description' | 'tags'>;
      ownerId?: string;
      bbox?: [number, number, number, number];
      bufferKm?: number;
    } = {};
    // type accepts a single ItemType, an array, or a comma-separated
    // string. Each token validated against the runtime ITEM_TYPES set
    // -- a smart folder can never produce items with a bogus type.
    if (typeof q.type === 'string' && q.type.length > 0) {
      const tokens = q.type
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const valid = tokens.filter(
        (t): t is ItemType => SMART_FOLDER_TYPES.includes(t),
      );
      if (valid.length === 1) opts.type = valid[0]!;
      else if (valid.length > 1) opts.type = valid;
    } else if (Array.isArray(q.type)) {
      const valid = q.type.filter(
        (t): t is ItemType =>
          typeof t === 'string' && SMART_FOLDER_TYPES.includes(t),
      );
      if (valid.length === 1) opts.type = valid[0]!;
      else if (valid.length > 1) opts.type = valid;
    }
    if (typeof q.q === 'string' && q.q.length > 0) opts.q = q.q;
    if (Array.isArray(q.searchFields)) {
      const valid = q.searchFields.filter(
        (f): f is 'title' | 'description' | 'tags' =>
          f === 'title' || f === 'description' || f === 'tags',
      );
      if (valid.length > 0) opts.searchFields = valid;
    }
    if (typeof q.ownerId === 'string' && q.ownerId.length > 0) {
      opts.ownerId = q.ownerId;
    }
    if (
      Array.isArray(q.bbox) &&
      q.bbox.length === 4 &&
      q.bbox.every((n: unknown) => typeof n === 'number' && Number.isFinite(n))
    ) {
      opts.bbox = q.bbox as [number, number, number, number];
    }
    if (typeof q.bufferKm === 'number' && q.bufferKm >= 0) {
      opts.bufferKm = q.bufferKm;
    }
    const rows = await this.list(user, opts);
    const limit =
      typeof q.limit === 'number' && q.limit > 0
        ? Math.min(Math.floor(q.limit), 1000)
        : 1000;
    return Array.isArray(rows) ? rows.slice(0, limit) : rows;
  }

  async listFolderContents(user: AuthUser, id: string) {
    const folder = await this.get(user, id);
    if (folder.type !== 'folder') {
      throw new BadRequestException('Item is not a folder');
    }
    const data = folder.data as {
      childItemIds?: unknown;
      smartQuery?: unknown;
    } | null;

    // Smart-folder branch (#38). When the folder carries a
    // smartQuery, its contents are computed by running the items
    // list endpoint with that query's filters. Reuses every authz
    // path items.list already honors -- per-share access, owner /
    // admin / public bypass, folder-share inheritance -- so smart
    // folders never accidentally widen a caller's visible set.
    // childItemIds is preserved on the row but ignored for
    // membership while smartQuery is present.
    //
    // Empty smartQuery ({}) falls through to the regular folder
    // path. Older folder editors persist an empty smart-query
    // shell on save (#101 follow-up); without this guard, those
    // folders run a filter-less items.list and return every
    // item in the org -- which the user sees as "Project B is
    // showing all 13 items even though it only has 2 children".
    const sq = data?.smartQuery;
    if (
      sq &&
      typeof sq === 'object' &&
      Object.keys(sq as Record<string, unknown>).length > 0
    ) {
      return this.resolveSmartFolder(user, sq);
    }

    const ids = Array.isArray(data?.childItemIds)
      ? (data!.childItemIds as unknown[]).filter(
          (x): x is string => typeof x === 'string' && x.length > 0,
        )
      : [];
    if (ids.length === 0) return [];

    // Folder share = grant on the folder, not on its contents.
    // Per-item visibility (visibleWhere) ALWAYS applies to the
    // children query -- a private item inside a shared folder
    // stays private. This matches the principle of least surprise:
    // a teammate shared on a folder can navigate to it and see
    // which items they have access to inside, but private content
    // never silently becomes visible just because the container
    // was shared.
    //
    // Earlier slice (#44) had a callerHasFolderAccess bypass that
    // let folder shares cascade to every child. That confused
    // testing across users: an admin's private map showed up
    // under a folder shared with a contributor. Ripped out
    // 2026-04-26.
    const rows = await this.prisma.item.findMany({
      where: {
        AND: [
          this.sharing.visibleWhere(user),
          { id: { in: ids } },
          { deletedAt: null },
        ],
      },
      include: {
        shares: true,
        owner: {
          select: {
            id: true,
            username: true,
            fullName: true,
            avatarUrl: true,
          },
        },
      },
    });
    // Preserve the folder's authoritative ordering. Items the caller
    // cannot see / trashed / orphaned simply do not appear; we don't
    // expose a count hint either way (information leak).
    const order = new Map<string, number>();
    ids.forEach((rid, i) => order.set(rid, i));
    rows.sort(
      (a, b) =>
        (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
    return rows;
  }

  /**
   * Items THIS one references (forward edges).
   *
   * Two modes mirror listDependents:
   *   - direct (default): every id named in the item's data.* refs.
   *   - transitive: plus every item those reach in turn (a
   *     data_collection -> map -> data_layers -> pick_lists chain).
   *
   * Implementation: BFS forward from the seed item. Each hop calls
   * extractDependencies on the just-fetched row, adds newly-discovered
   * itemIds to the frontier, and resolves any URL refs by scanning
   * arcgis_service rows in the org once and matching normalised urls.
   * Cycle-guarded by `seen`. The seed item itself is never included
   * in the result.
   */
  async listDependencies(
    user: AuthUser,
    id: string,
    opts: { transitive?: boolean } = {},
  ) {
    const item = await this.get(user, id);

    const visible = this.sharing.visibleWhere(user);

    // Pull every arcgis_service in the org once so URL refs at any
    // BFS depth can resolve to item ids via the same matcher we use
    // for the direct-only path. Cheap on a typical org (single-digit
    // arcgis_service rows); cached for the duration of this call.
    let arcgisIndex: Array<{ id: string; normalized: string }> | null = null;
    const resolveUrls = async (urls: string[]): Promise<string[]> => {
      if (urls.length === 0) return [];
      if (arcgisIndex === null) {
        const candidates = await this.prisma.item.findMany({
          where: {
            orgId: user.orgId,
            type: 'arcgis_service',
            deletedAt: null,
          },
          select: { id: true, data: true },
        });
        arcgisIndex = candidates
          .map((c) => {
            const rowUrl = (c.data as { url?: unknown } | null)?.url;
            return typeof rowUrl === 'string'
              ? { id: c.id, normalized: normalizeArcgisUrl(rowUrl) }
              : null;
          })
          .filter((x): x is { id: string; normalized: string } => x !== null);
      }
      const wanted = new Set(urls.map((u) => normalizeArcgisUrl(u)));
      const out: string[] = [];
      for (const a of arcgisIndex) {
        if (wanted.has(a.normalized)) out.push(a.id);
      }
      return out;
    };

    // Seed: extract from the item we already have in memory.
    const seedDeps = extractDependencies(item);
    const seedUrlIds = await resolveUrls(seedDeps.urls);
    const collected = new Set<string>();
    const frontier: string[] = [];
    const enqueue = (newIds: string[]) => {
      for (const nid of newIds) {
        if (nid === id) continue; // never include the seed in its own result
        if (collected.has(nid)) continue;
        collected.add(nid);
        frontier.push(nid);
      }
    };
    enqueue([...seedDeps.itemIds, ...seedUrlIds]);

    // BFS only fires when the caller asked for transitive. Direct
    // mode stops with the seed's first-hop set, matching the
    // historical behaviour of this endpoint.
    if (opts.transitive && frontier.length > 0) {
      // We need each frontier row's `data` to call extractDependencies
      // again. Pull them in batches by id; ignore rows the caller can't
      // see (visibility predicate is applied to the final result, but
      // here we still want to traverse every edge so a private chain
      // doesn't silently truncate the indirect set just because one
      // intermediate node isn't shared with the caller -- the visibility
      // gate at render time decides what they see).
      while (frontier.length > 0) {
        const batch = frontier.splice(0, frontier.length);
        const rows = await this.prisma.item.findMany({
          where: { id: { in: batch }, deletedAt: null },
          select: {
            id: true,
            type: true,
            data: true,
            // #80: tier-level geo-boundary refs are real edges. Pull
            // them so a public-tier-clipped data_layer surfaces its
            // boundary in dependency walks (cascade prompts, used-by).
            publicGeoBoundaryId: true,
            orgGeoBoundaryId: true,
          },
        });
        for (const r of rows) {
          const deps = extractDependencies(r);
          const urlIds = await resolveUrls(deps.urls);
          enqueue([...deps.itemIds, ...urlIds]);
        }
      }
    }

    if (collected.size === 0) return [];

    return this.prisma.item.findMany({
      where: {
        id: { in: Array.from(collected) },
        deletedAt: null,
        ...visible,
      },
      select: {
        id: true,
        type: true,
        title: true,
        thumbnailUrl: true,
        description: true,
        updatedAt: true,
        access: true,
      },
      orderBy: { title: 'asc' },
    });
  }

  /**
   * Cascade-revert candidates (#334). Inverse of the
   * cascade-on-public flow (#310): when the caller is about to flip
   * an item OUT of access='public', return the transitive
   * dependencies that:
   *
   *   - are currently access='public', and
   *   - are NOT also depended on by ANY OTHER access='public' item in
   *     the same org (other than the parent being changed).
   *
   * Those are the items the user can safely downgrade with the
   * parent: they're only public because of this parent, so taking
   * the parent private leaves no public consumer. A dep that's also
   * referenced by another public item is omitted -- downgrading it
   * would break the other public consumer's anonymous render.
   *
   * Caller is responsible for actually applying the downgrade
   * (sequential PATCHes to /items/:id with { access }) AFTER the
   * user confirms; this endpoint only computes the candidate list.
   * The downgrade target tier defaults to 'org' on the client; the
   * user can override per item if they want strict private.
   *
   * Performance: O(P * D) where P is public items in the org and D
   * is the average transitive-dep count per public item. For most
   * orgs (P < 50, D < 20) this is comfortable. If catalogs grow
   * larger, swap for a maintained item_dependency table.
   */
  async listCascadeRevertCandidates(user: AuthUser, id: string) {
    // Same visibility gate as listDependencies. The caller has to be
    // able to see the item itself before walking its graph.
    await this.get(user, id);

    // 1. Pull this item's transitive deps that are currently public.
    const myDeps = await this.listDependencies(user, id, {
      transitive: true,
    });
    const publicDeps = myDeps.filter((d) => d.access === 'public');
    if (publicDeps.length === 0) return [];

    // 2. Find every OTHER public item in the org. We need their full
    //    `data` so we can walk their transitive deps and compute the
    //    "still needed by some other public" set.
    const otherPublics = await this.prisma.item.findMany({
      where: {
        orgId: user.orgId,
        access: 'public',
        deletedAt: null,
        id: { not: id },
      },
      select: {
        id: true,
        type: true,
        data: true,
        publicGeoBoundaryId: true,
        orgGeoBoundaryId: true,
      },
    });

    // 3. Walk every other public item's transitive deps, union the
    //    reached ids into stillNeeded. publicDeps that AREN'T in
    //    stillNeeded are safe to revert.
    const stillNeeded = new Set<string>();
    for (const op of otherPublics) {
      // Direct hop: the ids the item explicitly names.
      const seed = extractDependencies(op);
      const collected = new Set<string>(seed.itemIds);
      const frontier: string[] = [...seed.itemIds];
      // BFS for transitive coverage. Same shape as listDependencies's
      // BFS but inlined here so we don't double-pay the per-call
      // arcgis URL index build for each public item; URL refs aren't
      // load-bearing for the cascade-revert decision (a URL ref
      // points at an arcgis_service item, which IS in the dep set).
      while (frontier.length > 0) {
        const batch = frontier.splice(0, frontier.length);
        const rows = await this.prisma.item.findMany({
          where: { id: { in: batch }, deletedAt: null },
          select: {
            id: true,
            type: true,
            data: true,
            publicGeoBoundaryId: true,
            orgGeoBoundaryId: true,
          },
        });
        for (const r of rows) {
          const deps = extractDependencies(r);
          for (const nid of deps.itemIds) {
            if (!collected.has(nid)) {
              collected.add(nid);
              frontier.push(nid);
            }
          }
        }
      }
      for (const dep of collected) stillNeeded.add(dep);
    }

    return publicDeps.filter((d) => !stillNeeded.has(d.id));
  }

  /**
   * Return the items that reference THIS one (reverse edges).
   *
   * Two modes:
   *   - direct (default): every item whose data.* names this item id.
   *   - transitive: plus every item that indirectly references it
   *     through another dependent. E.g. a layer used by a map,
   *     which is in turn used by a dashboard.
   *
   * Implementation: scan every referencer-type item in the org (small
   * set: today just map), build a reverse index, then either
   * return the direct hits or BFS outward for the transitive mode.
   *
   * For O(100k) items per org this is fine; if catalogs get bigger,
   * swap for an `item_dependency` table maintained by the same
   * extractor on item write.
   */
  async listDependents(
    user: AuthUser,
    id: string,
    opts: { transitive?: boolean } = {},
  ) {
    // Caller must be able to see the item itself before asking who
    // depends on it. We keep the returned row so downstream logic can
    // decide how to match: by uuid for most items, by normalized URL
    // when the target is an arcgis_service (whose web-map layer refs
    // are URL-based, not id-based).
    const target = await this.get(user, id);
    const targetUrl =
      target.type === 'arcgis_service'
        ? ((target.data as { url?: unknown } | null)?.url as string | undefined)
        : undefined;
    const normalizedTargetUrl = targetUrl
      ? normalizeArcgisUrl(targetUrl)
      : null;

    // Pull every referencer-type item in the org: we need their data
    // to extract refs. We'll filter for visibility when shaping the
    // response.
    const referencers = await this.prisma.item.findMany({
      where: {
        orgId: user.orgId,
        type: { in: REFERENCER_TYPES },
        deletedAt: null,
      },
      select: {
        id: true,
        type: true,
        title: true,
        thumbnailUrl: true,
        description: true,
        updatedAt: true,
        access: true,
        data: true,
        ownerId: true,
        // #80: tier-level boundary refs participate in the reverse
        // index, so a geo_boundary's "Used by" panel surfaces every
        // item that's clipped to it (not just data_layers/maps that
        // mention it via data_json).
        publicGeoBoundaryId: true,
        orgGeoBoundaryId: true,
      },
    });

    // Reverse index: target key -> referrer ids. Target keys are
    // either item UUIDs ("id:<uuid>") or normalized arcgis URLs
    // ("url:<normalized>"). Keeps both kinds of reference in one
    // map so BFS stays simple.
    const reverse = new Map<string, string[]>();
    for (const r of referencers) {
      const deps = extractDependencies(r);
      for (const d of deps.itemIds) {
        const key = `id:${d}`;
        const arr = reverse.get(key) ?? [];
        arr.push(r.id);
        reverse.set(key, arr);
      }
      for (const u of deps.urls) {
        const key = `url:${u}`;
        const arr = reverse.get(key) ?? [];
        arr.push(r.id);
        reverse.set(key, arr);
      }
    }

    // BFS from the target key outward. For arcgis_service we seed with
    // both the url-key AND the id-key (some other item type might one
    // day reference an arcgis_service by id); for everything else just
    // the id-key. Cycle-guarded by `seen`.
    const seen = new Set<string>();
    const seedKeys = normalizedTargetUrl
      ? [`id:${id}`, `url:${normalizedTargetUrl}`]
      : [`id:${id}`];
    const frontier: string[] = [...seedKeys];
    const hits = new Set<string>();
    while (frontier.length > 0) {
      const next = frontier.shift()!;
      const ancestors = reverse.get(next) ?? [];
      for (const a of ancestors) {
        if (seen.has(a)) continue;
        seen.add(a);
        hits.add(a);
        if (opts.transitive) frontier.push(`id:${a}`);
      }
    }

    if (hits.size === 0) return [];

    // Re-query with the visibility predicate so per-row access
    // (public / org / explicit share / ownership) is enforced by the
    // same logic the rest of the app uses instead of a hand-rolled
    // duplicate. This is the only non-trivial SQL we do here; it runs
    // once against a bounded id set.
    const visible = this.sharing.visibleWhere(user);
    return this.prisma.item.findMany({
      where: {
        id: { in: Array.from(hits) },
        deletedAt: null,
        ...visible,
      },
      select: {
        id: true,
        type: true,
        title: true,
        thumbnailUrl: true,
        description: true,
        updatedAt: true,
        access: true,
      },
      orderBy: { title: 'asc' },
    });
  }
}

/**
 * Narrow an item's data payload to the v3 layer list when it's a v3
 * data_layer. Returns null for v1/v2 items (so callers can skip
 * the v3 reconcile path) or when the payload doesn't look like a
 * valid v3 shape.
 */
function readV3Layers(data: unknown): DataLayerLayerShape[] | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { version?: unknown; layers?: unknown };
  if (d.version !== 3) return null;
  if (!Array.isArray(d.layers)) return [];
  return d.layers
    .map((raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const l = raw as Record<string, unknown>;
      const id = typeof l.id === 'string' ? l.id : '';
      if (!id) return null;
      const gt = l.geometryType;
      const geometryType: DataLayerLayerShape['geometryType'] =
        gt === 'point' || gt === 'line' || gt === 'polygon' ? gt : null;
      const fields: NonNullable<DataLayerLayerShape['fields']> = Array.isArray(
        l.fields,
      )
        ? (l.fields as Array<Record<string, unknown>>)
            .map((f) => {
              const name = typeof f.name === 'string' ? f.name : '';
              const type: 'string' | 'number' | 'boolean' | 'date' =
                f.type === 'number' ||
                f.type === 'boolean' ||
                f.type === 'date'
                  ? f.type
                  : 'string';
              const searchable = f.searchable === true;
              return searchable
                ? { name, type, searchable }
                : { name, type };
            })
            .filter((f) => f.name.length > 0)
        : [];
      const out: DataLayerLayerShape = {
        id,
        geometryType,
        fields,
      };
      if (typeof l.parentFkColumn === 'string' && l.parentFkColumn.length > 0) {
        out.parentFkColumn = l.parentFkColumn;
      }
      return out;
    })
    .filter((l): l is DataLayerLayerShape => l !== null);
}

/**
 * Compare prev vs next v3 layer arrays and return the keys whose
 * change would break offline copies (#230 Phase A). Currently
 * narrow:
 *
 *   - dropped: a layer id that existed in prev but not in next.
 *     Field offline copies still reference the underlying table
 *     by id; the next sync 400s with "table not found" the same
 *     way Esri's "DBMS table not found" surfaces.
 *   - geometryChanged: a layer id whose geometryType differs
 *     between prev and next. Cached features in the offline DB
 *     have the old geometry shape; the next sync rejects them.
 *
 * Field renames / drops within a layer are deliberately out of
 * scope for v1 -- they're recoverable via the offline-recovery
 * flow without surfacing as a hard sync failure. Add them here
 * if we see real breakage in the wild.
 */
function computeSchemaBreaks(
  prev: DataLayerLayerShape[],
  next: DataLayerLayerShape[],
): { dropped: string[]; geometryChanged: string[] } {
  const nextById = new Map(next.map((l) => [l.id, l] as const));
  const dropped: string[] = [];
  const geometryChanged: string[] = [];
  for (const p of prev) {
    const n = nextById.get(p.id);
    if (!n) {
      dropped.push(p.id);
      continue;
    }
    if (p.geometryType !== n.geometryType) {
      geometryChanged.push(p.id);
    }
  }
  return { dropped, geometryChanged };
}
