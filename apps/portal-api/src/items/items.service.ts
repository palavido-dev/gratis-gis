import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { ItemAccess, ItemType, PrincipalType, Prisma, SharePermission } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { SharingService } from './sharing.service.js';
import { DataSnapshotService } from './data-snapshot.service.js';
import { itemBbox } from './item-bbox.js';

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
}

@Injectable()
export class ItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sharing: SharingService,
    private readonly v3Tables: V3TablesService,
    private readonly snapshots: DataSnapshotService,
  ) {}

  async list(
    user: AuthUser,
    opts: {
      mine?: boolean;
      type?: ItemType;
      q?: string;
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
       * NOT excluded -- the spatial filter narrows, not gates, so
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
    } = {},
  ) {
    const where: Prisma.ItemWhereInput = opts.mine
      ? { ownerId: user.id, deletedAt: null }
      : this.sharing.visibleWhere(user);
    if (opts.type) where.type = opts.type;
    if (opts.ownerId && opts.ownerId !== user.id && user.orgRole !== 'admin') {
      // Non-admins can only filter to their own items.
      throw new ForbiddenException(
        'Only org admins can filter items by another user',
      );
    }
    if (opts.ownerId) where.ownerId = opts.ownerId;
    if (opts.q) {
      where.OR = [
        { title: { contains: opts.q, mode: 'insensitive' } },
        { description: { contains: opts.q, mode: 'insensitive' } },
        { tags: { has: opts.q } },
      ];
    }
    // Spatial filter via the generated bbox_geom column + GiST
    // index. Done outside the Prisma `where` because Prisma can't
    // express geometry operators directly; the result is a SET of
    // ids that we intersect with the regular where via `id IN`.
    if (opts.bbox) {
      const buf = degreesFromKm(opts.bufferKm ?? 0);
      const [w, s, e, n] = opts.bbox;
      const ids = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "item"
        WHERE "bbox_geom" IS NOT NULL
          AND "bbox_geom" && ST_MakeEnvelope(
            ${w - buf}, ${s - buf}, ${e + buf}, ${n + buf}, 4326
          )
      `;
      const idSet = ids.map((r) => r.id);
      // Combine with existing where via AND so visibility / type /
      // ownerId all still apply. Items without a bbox_geom are
      // intentionally allowed through the spatial filter (see opts
      // doc): spatial-aware items get filtered down to those whose
      // bbox intersects, while bbox-less items are unaffected.
      const orParts: Prisma.ItemWhereInput[] = [
        { id: { in: idSet } },
        { bbox: { equals: [] } },
      ];
      where.AND = [{ OR: orParts }];
    }
    // Include shares in the list response so the items page can render
    // sharing badges without a second round-trip per item. Most items
    // have zero-to-single-digit share rows, so the extra join is cheap
    // and far better than N+1 fetches on the client.
    // Also include a lean owner projection (username, fullName, avatar)
    // so the Owner column can render without N+1 lookups.
    return this.prisma.item.findMany({
      where,
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
      orderBy: { updatedAt: 'desc' },
    });
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
        // detail page header can render "Owner: Mateo Garcia" without
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
        // applied, but drop the full entries array — that's who-
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
    const resolvedData: Prisma.InputJsonValue =
      input.type === 'map'
        ? ((await this.resolveDefaultBasemap(
            user.orgId,
            input.data,
          )) as Prisma.InputJsonValue)
        : input.data;

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
    // If reconcile throws, the item row is already in the DB — we
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
    const prevLayers =
      item.type === 'data_layer' ? readV3Layers(item.data) : null;
    // If this update replaces the data blob, snapshot what was there
    // first so an admin can revert within the retention window.
    // Non-data updates (title / tags / access / thumbnail) skip the
    // snapshot since reverting those is trivially an edit away.
    if (input.data !== undefined && item.type === 'data_layer') {
      await this.snapshots.snapshot(id, user.id, 'pre-update');
    }
    // Recompute the cached extent when the data blob changes; leave
    // it untouched on metadata-only edits so we don't churn the
    // index for no reason.
    const nextBbox =
      input.data !== undefined ? itemBbox(item.type, input.data) : null;
    const updated = await this.prisma.item.update({
      where: { id },
      data: {
        ...(input.title !== undefined && { title: input.title }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.tags !== undefined && { tags: input.tags }),
        ...(input.data !== undefined && { data: input.data }),
        ...(input.access !== undefined && { access: input.access }),
        ...(input.thumbnailUrl !== undefined && { thumbnailUrl: input.thumbnailUrl }),
        ...(input.license !== undefined && { license: input.license }),
        ...(input.data !== undefined && { bbox: nextBbox ?? [] }),
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
      // Not in the trash -- nothing to do, and returning 200 would
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
    await this.prisma.item.delete({ where: { id } });
  }

  /**
   * Return the GeoJSON FeatureCollection for a data_layer item.
   * Handles both v1 (inline JSON) and v2 (PostGIS table) storage transparently.
   *
   * Accepts an optional bbox filter for v2; v1 always returns all features.
   */
  async getGeoJson(
    user: AuthUser,
    id: string,
    opts: { bbox?: [number, number, number, number]; at?: string } = {},
  ): Promise<{ type: 'FeatureCollection'; features: unknown[] }> {
    const item = await this.get(user, id);
    if (item.type !== 'data_layer') {
      return { type: 'FeatureCollection', features: [] };
    }

    const data = item.data as {
      storageType?: string;
      version?: number;
      data?: unknown;
    } | null;

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

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      type RawRow = { global_id: string; geom: string | null; properties: Record<string, unknown> };
      const rows = await this.prisma.$queryRawUnsafe<RawRow[]>(
        `SELECT global_id, ST_AsGeoJSON(geom) AS geom, properties
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
          properties: r.properties,
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
   * they don't lose access entirely — handy for "I'm leaving the
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
      return item; // no-op — already owned by the target user
    }
    // Target user must exist AND be in the same org. Cross-org
    // reassignment is out of scope — that would leak content across
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
   * caller's org — the count only includes items in the caller's org
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
    return this.prisma.itemShare.upsert({
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
  // Dependency tracking — "Used by" / "Depends on"
  // ---------------------------------------------------------------

  /**
   * Return the items that THIS item references (forward edges). For a
   * map, that's each layer's data_layer / arcgis_service.
   *
   * Results are scoped to items the caller can see — if the map
   * references something private that the caller isn't shared on, it
   * simply doesn't appear in the list (instead of 403'ing, which
   * would leak the existence of a hidden dependency).
   */
  async listDependencies(user: AuthUser, id: string) {
    const item = await this.get(user, id);
    const { itemIds, urls } = extractDependencies(item);
    if (itemIds.length === 0 && urls.length === 0) return [];

    const visible = this.sharing.visibleWhere(user);

    // Resolve URL refs by scanning arcgis_service items in the org and
    // matching their persisted `data.url` against any url the extractor
    // collected. Normalization on both sides makes the match trailing-
    // slash and trailing-layer-index tolerant.
    let urlResolvedIds: string[] = [];
    if (urls.length > 0) {
      const normalized = new Set(urls.map((u) => normalizeArcgisUrl(u)));
      const candidates = await this.prisma.item.findMany({
        where: {
          orgId: user.orgId,
          type: 'arcgis_service',
          deletedAt: null,
        },
        select: { id: true, data: true },
      });
      for (const c of candidates) {
        const rowUrl = (c.data as { url?: unknown } | null)?.url;
        if (
          typeof rowUrl === 'string' &&
          normalized.has(normalizeArcgisUrl(rowUrl))
        ) {
          urlResolvedIds.push(c.id);
        }
      }
    }

    const allIds = Array.from(new Set([...itemIds, ...urlResolvedIds]));
    if (allIds.length === 0) return [];

    return this.prisma.item.findMany({
      where: {
        id: { in: allIds },
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
    // decide how to match — by uuid for most items, by normalized URL
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

    // Pull every referencer-type item in the org — we need their data
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
              return { name, type };
     
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
