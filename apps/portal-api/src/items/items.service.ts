import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { ItemAccess, ItemType, PrincipalType, Prisma, SharePermission } from '@prisma/client';
import { ITEM_TYPES } from '@gratis-gis/shared-types';

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
 * Coarse degree-equivalent of a kilometer buffer. Good enough for
 * "show items near this region" search; not for any kind of
 * geodesic computation. 1 degree of latitude is roughly 111 km;
 * longitude varies with latitude so we err on the wide side.
 */
function degreesFromKm(km: number): number {
  return Math.min(Math.max(km, 0), 100_000) / 111;
}
import {
  extractDependencies,
  normalizeArcgisUrl,
  REFERENCER_TYPES,
} from './dependency-extractor.js';
import {
  V3TablesService,
  type V3LayerShape,
} from '../features-v3/v3-tables.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { DerivedLayersService } from '../derived-layers/derived-layers.service.js';

// Optional fields use `| undefined` explicitly so class-validator DTOs
// (which leave unset keys present-as-undefined) can satisfy these types
// under `exactOptionalPropertyTypes: true`.
export interface CreateItemInput {
  type: ItemType;
  title: string;
  description?: string | undefined;
  tags?: string[] | undefined;
  data: Prisma.InputJsonValue;
  access?: ItemAccess | undefined;
  /** Pass null or omit to start without a custom thumbnail. */
  thumbnailUrl?: string | null | undefined;
  /** Open-data license; null / omitted = not recorded. */
  license?: string | null | undefined;
}

export interface UpdateItemInput {
  title?: string | undefined;
  description?: string | undefined;
  tags?: string[] | undefined;
  data?: Prisma.InputJsonValue | undefined;
  access?: ItemAccess | undefined;
  /** Pass null to clear. */
  thumbnailUrl?: string | null | undefined;
  /** Pass null to clear a previously-set license. */
  license?: string | null | undefined;
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
    private readonly v3Tables: V3TablesService,
    private readonly snapshots: DataSnapshotService,
    private readonly notifications: NotificationsService,
    private readonly derivedLayers: DerivedLayersService,
  ) {}

  async list(
    user: AuthUser,
    opts: {
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
       * `data` JSONB blob and instead attaches a `_subLayerCount`
       * derived field on arcgis_service items so the Add Layer
       * dialog can still render the "+N layers" badge without
       * shipping hundreds of KB of layer metadata per row. Callers
       * that need the full payload (the items page, item detail
       * fetches) leave this off. (#52)
       */
      lite?: boolean;
      /**
       * Filter to items that have an active share row pointing at the
       * given group (#100). The Add Layer dialog's Groups tab uses
       * this so an author drilling into a group sees only the items
       * the group has been granted access to. Note we still apply
       * `visibleWhere` -- a non-member of the group with no other
       * route to an item should not see it appear here. The intersection
       * is the right "items in this group from my perspective" set.
       */
      sharedWithGroupId?: string;
    } = {},
  ) {
    // Lightweight per-call timing log behind the ITEMS_LIST_TIMING env
    // flag so a slow load can be diagnosed without hand-instrumenting
    // every request. Overhead is one Date.now() per phase so it is
    // safe to leave on in production if needed.
    const traceTiming = process.env.ITEMS_LIST_TIMING === '1';
    const tStart = traceTiming ? Date.now() : 0;

    const where: Prisma.ItemWhereInput = opts.mine
      ? { ownerId: user.id, deletedAt: null }
      : this.sharing.visibleWhere(user);

    // Folder-share cascade was retired 2026-04-26 (#68). Folder
    // shares grant access to the folder itself (#63), not its
    // contents. Authors who want a folder's audience to also see
    // the items inside use the "Apply folder sharing" bulk action
    // on the folder page (#67), which writes real share rows on
    // each child item. Cleaner contract: items.list answers from
    // visibleWhere alone; no inherited-id splicing. tInheritDone
    // stays in the timing log as a zero-duration step so the log
    // format doesn't have to change in this commit.
    const tInheritStart = traceTiming ? Date.now() : 0;
    let tInheritDone = tInheritStart;
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
    if (traceTiming && tInheritDone === 0) tInheritDone = Date.now();
    const baseSelect = {
      id: true,
      orgId: true,
      ownerId: true,
      type: true,
      title: true,
      description: true,
      tags: true,
      thumbnailUrl: true,
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
    const rows = opts.lite
      ? await this.prisma.item.findMany({
          where,
          select: baseSelect,
          orderBy: { updatedAt: 'desc' },
        })
      : await this.prisma.item.findMany({
          where,
          select: { ...baseSelect, data: true },
          orderBy: { updatedAt: 'desc' },
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
        return r;
      });
    }

    if (traceTiming) {
      const tFindDone = Date.now();
      const typeLabel = Array.isArray(opts.type)
        ? opts.type.join('|')
        : (opts.type ?? 'any');
      // eslint-disable-next-line no-console
      console.log(
        `[items.list] type=${typeLabel} mine=${opts.mine ?? false} ` +
          `lite=${opts.lite ?? false} q=${opts.q ?? ''} ` +
          `rows=${rows.length} ` +
          `inherit=${tInheritDone - tStart}ms ` +
          `findMany=${tFindDone - tInheritDone}ms ` +
          `total=${tFindDone - tStart}ms`,
      );
    }
    return result;
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
    return this.prisma.item.findMany({ where, orderBy: { deletedAt: 'desc' } });
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
      return item;
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
      return { ...item, data: filtered as typeof item.data };
    }
    return item;
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

    const bbox = itemBbox(input.type, resolvedData);
    const row = await this.prisma.item.create({
      data: {
        orgId: user.orgId,
        ownerId: user.id,
        type: input.type,
        title: input.title,
        description: input.description ?? '',
        tags: input.tags ?? [],
        data: resolvedData,
        access: input.access ?? 'private',
        bbox: bbox ?? [],
        ...(input.thumbnailUrl ? { thumbnailUrl: input.thumbnailUrl } : {}),
        ...(input.license !== undefined && input.license !== null ? { license: input.license } : {}),
      },
    });
    // v3 feature-service items: provision a PostGIS table per layer
    // defined in the builder. Safe to run inline because each
    // $executeRawUnsafe is idempotent; if the item has no layers yet
    // (empty builder), this is a no-op.
    //
    // If reconcile throws, the item row is already in the DB: we
    // roll back by deleting it so the user doesn't end up with an
    // orphaned item they can't recover from. The error message is
    // surfaced back to the caller so they can see WHICH column /
    // layer / DDL failed instead of a bare 500.
    const layers = readV3Layers(row.data);
    if (row.type === 'data_layer' && layers !== null) {
      try {
        await this.v3Tables.reconcile(row.id, [], layers);
      } catch (err) {
        await this.prisma.item
          .delete({ where: { id: row.id } })
          .catch(() => {
            /* best-effort cleanup; if this fails too we leave the orphan */
          });
        throw new BadRequestException(
          `Could not provision layer tables: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return row;
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
    const source = await this.prisma.item.findUnique({
      where: { id: sourceRef.itemId },
      include: { shares: true },
    });
    if (
      !source ||
      source.deletedAt !== null ||
      !this.sharing.canRead(user, source, source.shares)
    ) {
      // Match items.service.get's existence-vs-access idiom:
      // surface the same generic error regardless of whether the
      // source is missing, trashed, or unshared, so an attacker
      // can't probe for hidden item ids.
      throw new BadRequestException(
        'derived_layer.source.itemId does not point at an accessible data layer',
      );
    }
    const enriched = await this.derivedLayers.validateAndEnrich(
      rawData,
      source,
    );
    return enriched as unknown as Prisma.JsonValue;
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
        ...(input.thumbnailUrl !== undefined && { thumbnailUrl: input.thumbnailUrl }),
        ...(input.license !== undefined && { license: input.license }),
        ...(nextData !== undefined && { bbox: nextBbox ?? [] }),
      },
    });
    // v3: reconcile layer tables against the updated schema. prev lets
    // us drop tables for layers that were removed from the schema;
    // reconcile is idempotent for layers that stayed.
    const nextLayers =
      updated.type === 'data_layer' ? readV3Layers(updated.data) : null;
    if (nextLayers !== null) {
      await this.v3Tables.reconcile(
        updated.id,
        prevLayers ?? [],
        nextLayers,
      );
    }
    return updated;
  }

  /**
   * Soft-delete: mark the item as trashed. The row (and its shares) stays
   * in the database so it can be restored. A scheduled job purges rows
   * whose deletedAt is older than the retention window (see
   * docs/soft-delete.md).
   */
  async remove(user: AuthUser, id: string) {
    const item = await this.get(user, id);
    if (!this.sharing.canAdmin(user, item)) {
      throw new ForbiddenException('Only the owner or an org admin can delete an item');
    }
    await this.prisma.item.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /** Restore a trashed item. Only the owner or an org admin can restore. */
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
    return this.prisma.item.update({
      where: { id },
      data: { deletedAt: null },
    });
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
    // Drop any backing PostGIS tables before removing the item row so
    // we can still reference the item id to build the table name(s).
    if (item.type === 'data_layer') {
      const data = item.data as { version?: number; storageType?: string } | null;
      // v2 (single table per item)
      if (data?.storageType === 'postgis' && data?.version !== 3) {
        const tbl = `fs_${id.replace(/-/g, '')}`;
        await this.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${tbl}"`);
      }
      // v3 (one table per layer)
      const v3Layers = readV3Layers(item.data);
      if (v3Layers !== null) {
        await this.v3Tables.dropAll(id, v3Layers.map((l) => l.id));
      }
    }
    // Cascade folder cleanup: any folder whose data.childItemIds
    // references the now-purged UUID gets that UUID spliced out.
    // Soft-delete deliberately does NOT do this (so trash restoration
    // restores folder membership too); cleanup only runs at hard-delete
    // when the item is gone for good. See docs/folders.md.
    await this.spliceFromFolders(id);
    await this.prisma.item.delete({ where: { id } });
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
    } | null;

    // Resolve the boundary clip once up front so both v1 and v2
    // branches can use it. Bypasses per-user authz on the boundary
    // (see V3FeaturesController.resolveBoundaryGeometry for the
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
      // v2: query the PostGIS table.
      const tbl = `fs_${id.replace(/-/g, '')}`;
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
          select: { id: true, type: true, data: true },
        });
        for (const r of rows) {
          const deps = extractDependencies({ type: r.type, data: r.data });
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
      },
    });

    // Reverse index: target key -> referrer ids. Target keys are
    // either item UUIDs ("id:<uuid>") or normalized arcgis URLs
    // ("url:<normalized>"). Keeps both kinds of reference in one
    // map so BFS stays simple.
    const reverse = new Map<string, string[]>();
    for (const r of referencers) {
      const deps = extractDependencies({ type: r.type, data: r.data });
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
function readV3Layers(data: unknown): V3LayerShape[] | null {
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
      const geometryType: V3LayerShape['geometryType'] =
        gt === 'point' || gt === 'line' || gt === 'polygon' ? gt : null;
      const fields: NonNullable<V3LayerShape['fields']> = Array.isArray(
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
      const out: V3LayerShape = {
        id,
        geometryType,
        fields,
      };
      if (typeof l.parentFkColumn === 'string' && l.parentFkColumn.length > 0) {
        out.parentFkColumn = l.parentFkColumn;
      }
      return out;
    })
    .filter((l): l is V3LayerShape => l !== null);
}
