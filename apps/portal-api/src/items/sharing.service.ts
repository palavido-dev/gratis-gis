import { Injectable } from '@nestjs/common';
import type { Item, ItemShare, Prisma } from '@prisma/client';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Single source of truth for item access decisions. Mirrors the algorithm
 * in /docs/data-model.md. Everything that reads or writes items must go
 * through one of these methods.
 */
@Injectable()
export class SharingService {
  constructor(private readonly prisma: PrismaService) {}

  canRead(user: AuthUser, item: Item, shares: ItemShare[] = []): boolean {
    if (item.ownerId === user.id) return true;
    // Org admins see everything in their org: including private items
    // owned by other users. Mirrors the admin behaviour in canEdit /
    // canAdmin so the read path isn't strictly narrower than the
    // write path (which would be surprising).
    if (user.orgRole === 'admin' && item.orgId === user.orgId) return true;
    if (item.access === 'public') return true;
    if (item.access === 'org' && item.orgId === user.orgId) return true;
    return shares.some((s) => this.shareMatches(user, s));
  }

  canEdit(user: AuthUser, item: Item, shares: ItemShare[] = []): boolean {
    if (item.ownerId === user.id) return true;
    if (user.orgRole === 'admin' && item.orgId === user.orgId) return true;
    return shares.some(
      (s) =>
        (s.permission === 'edit' || s.permission === 'admin') && this.shareMatches(user, s),
    );
  }

  /**
   * `canDownload` sits between canRead and canEdit on the privilege
   * ladder. A user can download bulk data when:
   *   - they own the item, or are an org admin in its org
   *   - the item is `access: public` or `access: org` (same scope as
   *     canRead; public / org access has no meaningful "view but not
   *     download" middle ground because anyone could screen-scrape)
   *   - they have an explicit share at `download`, `edit`, or `admin`
   *
   * The middle tier is meaningful only for explicit shares: an owner
   * may share a data_layer with a partner so they can render it on a
   * map (`view`) without granting bulk extract (`download`). The
   * GeoJSON dump endpoint is the gate this protects today; future
   * CSV / Shapefile / GeoPackage exports will share the same gate.
   */
  canDownload(user: AuthUser, item: Item, shares: ItemShare[] = []): boolean {
    if (item.ownerId === user.id) return true;
    if (user.orgRole === 'admin' && item.orgId === user.orgId) return true;
    if (item.access === 'public') return true;
    if (item.access === 'org' && item.orgId === user.orgId) return true;
    return shares.some(
      (s) =>
        (s.permission === 'download' ||
          s.permission === 'edit' ||
          s.permission === 'admin') &&
        this.shareMatches(user, s),
    );
  }

  canAdmin(user: AuthUser, item: Item): boolean {
    if (item.ownerId === user.id) return true;
    return user.orgRole === 'admin' && item.orgId === user.orgId;
  }

  /**
   * Resolve the geographic restriction that applies to `user` on
   * `item`. Returns a GeoJSON geometry (Polygon, MultiPolygon, or
   * GeometryCollection) when the user is limited to a sub-region, or
   * `null` when they have unrestricted access.
   *
   * Semantics (matches the product-level design in docs/data-model.md):
   *   - Owners, admins, and anyone reading via `access: public` or
   *     `access: org` bypass geo limits entirely; those access paths
   *     are not share rows, so there's nothing to attach a polygon to.
   *   - When reading via an explicit `ItemShare`, the user's effective
   *     access is the UNION of every matching share's geo polygon. If
   *     any matching share has no polygon, the user has full access
   *     (the unrestricted share wins).
   *   - A matching share's clip is whichever of its two columns is
   *     populated: the inline `geoLimit` GeoJSON, or the geometry of
   *     the `geoBoundaryId` it references. If the referenced boundary
   *     no longer exists (or is the wrong item type, or has no
   *     geometry yet), that share is treated as unrestricted so a
   *     deleted boundary cannot silently expand access through some
   *     other matching share's polygon.
   *
   * Callers compose the result into SQL via `ST_GeomFromGeoJSON` +
   * `ST_Intersects`. Result is GeoJSON in EPSG:4326 so no coordinate
   * transform is needed before matching against feature tables.
   *
   * Async because the boundary reference path requires a DB lookup.
   */
  async geoLimitFor(
    user: AuthUser,
    item: Item,
    shares: ItemShare[] = [],
  ): Promise<unknown | null> {
    if (item.ownerId === user.id) return null;
    if (user.orgRole === 'admin' && item.orgId === user.orgId) return null;
    if (item.access === 'public') return null;
    if (item.access === 'org' && item.orgId === user.orgId) return null;

    const matching = shares.filter((s) => this.shareMatches(user, s));
    if (matching.length === 0) return null;

    // Look up every distinct geoBoundary referenced by any matching
    // share in a single round-trip; per-share resolution then reads
    // from this map. A boundary that doesn't exist (or isn't a
    // geo_boundary item, or has no geometry yet) just doesn't end
    // up in the map and the share that referenced it is treated as
    // unrestricted below.
    const boundaryIds = new Set<string>();
    for (const s of matching) {
      const ref = (s as ItemShare & { geoBoundaryId?: string | null })
        .geoBoundaryId;
      if (typeof ref === 'string' && ref.length > 0) boundaryIds.add(ref);
    }
    const boundaryGeoms = new Map<string, unknown>();
    if (boundaryIds.size > 0) {
      const rows = await this.prisma.item.findMany({
        where: {
          id: { in: Array.from(boundaryIds) },
          type: 'geo_boundary',
          deletedAt: null,
        },
        select: { id: true, data: true },
      });
      for (const r of rows) {
        const geom = (r.data as { geometry?: unknown } | null)?.geometry;
        if (geom && typeof geom === 'object') boundaryGeoms.set(r.id, geom);
      }
    }

    let hasUnrestricted = false;
    const polygons: unknown[] = [];
    for (const s of matching) {
      const ref = (s as ItemShare & { geoBoundaryId?: string | null })
        .geoBoundaryId;
      if (typeof ref === 'string' && ref.length > 0) {
        const geom = boundaryGeoms.get(ref);
        if (geom) polygons.push(geom);
        else hasUnrestricted = true; // boundary missing / wrong type / no geometry
        continue;
      }
      const inline = (s as ItemShare & { geoLimit?: unknown }).geoLimit;
      if (inline && typeof inline === 'object') polygons.push(inline);
      else hasUnrestricted = true;
    }
    if (hasUnrestricted) return null;
    if (polygons.length === 0) return null;
    if (polygons.length === 1) return polygons[0];
    return { type: 'GeometryCollection', geometries: polygons };
  }

  private shareMatches(user: AuthUser, share: ItemShare): boolean {
    if (share.principalType === 'user') return share.principalId === user.id;
    if (share.principalType === 'group') return user.groupIds.includes(share.principalId);
    return false;
  }

  /**
   * Return the set of item ids the caller can access via folder
   * inheritance (#44 phase 1c slice 3b). Walks downward from every
   * folder directly shared with the caller through any descendant
   * folder where inheritsParentShares is not explicitly false; the
   * descendant chain stops at the first opt-out folder. Items
   * sitting directly in any reachable folder are returned.
   *
   * Used by `list()` to widen visibility so a teammate who got a
   * folder share also sees the items the folder contains in the
   * flat all-items view, not just when they navigate into the
   * folder.
   *
   * Implementation: single recursive CTE; safe even at thousands of
   * folders / shares because the chain depth is bounded by the
   * folder hierarchy depth (typically 2-4).
   */
  async itemIdsAccessibleViaFolderShares(
    user: AuthUser,
  ): Promise<string[]> {
    if (user.orgRole === 'admin') return [];
    const groupIds = user.groupIds ?? [];
    type Row = { item_id: string };
    // The CTE:
    //   1. seed: folders the user is directly shared on (user share
    //      OR group share). Those are the "granted" folders.
    //   2. recurse: any folder whose UUID appears in a granted
    //      folder's data.childItemIds AND that has
    //      inheritsParentShares != false is also granted.
    //   3. flatten: every UUID in any granted folder's childItemIds
    //      is an accessible item.
    // jsonb operator `?` checks if a string is in a top-level array
    // OR a key in an object; for childItemIds (string[]) it does the
    // right thing.
    const rows = await this.prisma.$queryRaw<Row[]>`
      WITH RECURSIVE granted AS (
        SELECT i.id, i.data
        FROM "item" i
        WHERE i.type = 'folder'::"ItemType"
          AND i."deleted_at" IS NULL
          AND EXISTS (
            SELECT 1 FROM "item_share" s
            WHERE s."item_id" = i.id
              AND (
                (s."principal_type" = 'user' AND s."principal_id" = ${user.id}::uuid)
                OR (s."principal_type" = 'group' AND s."principal_id" = ANY(${groupIds}::uuid[]))
              )
          )
        UNION
        SELECT child.id, child.data
        FROM "item" child
        JOIN granted parent
          ON parent.data->'childItemIds' ? child.id::text
        WHERE child.type = 'folder'::"ItemType"
          AND child."deleted_at" IS NULL
          AND COALESCE((child.data->>'inheritsParentShares')::boolean, true) = true
      )
      SELECT DISTINCT child_id::uuid::text AS item_id
      FROM granted gf
      CROSS JOIN LATERAL jsonb_array_elements_text(
        COALESCE(gf.data->'childItemIds', '[]'::jsonb)
      ) AS child_id
    `;
    return rows.map((r) => r.item_id);
  }

  /**
   * Walk the folder ancestry of `folderId` and union in shares from
   * every ancestor folder where `data.inheritsParentShares` is not
   * explicitly false. Stops at the first folder that opts out.
   * Returns the merged share list (the folder's own shares first,
   * then ancestor shares in order of distance).
   *
   * Pairs with FolderData.inheritsParentShares (#44 phase 1c slice
   * 3). Used by listFolderContents to decide whether a caller who
   * lacks direct visibility on a child item should still see it
   * because they have access to a containing folder.
   *
   * Multi-parent folders (a folder appearing in more than one
   * parent's childItemIds) walk only the first parent encountered,
   * matching the rail tree's first-render behaviour. A more
   * principled multi-parent merge can come in a follow-up if the
   * use case appears.
   *
   * Cycle-safe via the visited set.
   */
  /**
   * Resolve inherited shares for ANY item (folder or otherwise),
   * tagged with the folder they came from. Used by the share
   * dialog so the UI can surface "Inherited from Project A"
   * captions on shares the caller didn't set directly.
   *
   * Walks up the folder ancestry from any folder that contains the
   * item, then continues up through parents where
   * inheritsParentShares is on. Returns the union, deduplicated by
   * (principalType, principalId) and keeping the closest ancestor
   * as the source. If a principal appears in multiple ancestors,
   * the closest wins so the UI can render a single attribution.
   */
  async inheritedSharesForItem(
    itemId: string,
  ): Promise<
    Array<
      ItemShare & {
        fromFolderId: string;
        fromFolderTitle: string;
      }
    >
  > {
    // Find every folder that directly contains this item -- the
    // first hop. Multi-parent folders are tolerated; we walk each.
    const directParents = await this.prisma.$queryRaw<
      Array<{ id: string; title: string }>
    >`
      SELECT id, title FROM "item"
      WHERE type = 'folder'::"ItemType"
        AND "deleted_at" IS NULL
        AND data @> jsonb_build_object('childItemIds', jsonb_build_array(${itemId}::text))
    `;
    if (directParents.length === 0) return [];

    type Tagged = ItemShare & {
      fromFolderId: string;
      fromFolderTitle: string;
    };
    const merged = new Map<string, Tagged>();
    const seen = new Set<string>();
    // BFS from the direct parents up; each step collects shares from
    // the visiting folder and stops at folders with
    // inheritsParentShares=false (they still contribute).
    const queue: Array<{ id: string; title: string; depth: number }> =
      directParents.map((p) => ({ ...p, depth: 0 }));
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      const row = await this.prisma.item.findFirst({
        where: { id: node.id, type: 'folder', deletedAt: null },
        select: { id: true, title: true, data: true, shares: true },
      });
      if (!row) continue;
      for (const s of row.shares) {
        const key = `${s.principalType}:${s.principalId}`;
        if (!merged.has(key)) {
          // First (closest) ancestor wins.
          merged.set(key, {
            ...s,
            fromFolderId: row.id,
            fromFolderTitle: row.title,
          } as Tagged);
        }
      }
      const data = row.data as
        | { inheritsParentShares?: unknown }
        | null;
      if (data && data.inheritsParentShares === false) continue;
      // Walk to parents of THIS folder (its ancestors).
      const parents = await this.prisma.$queryRaw<
        Array<{ id: string; title: string }>
      >`
        SELECT id, title FROM "item"
        WHERE type = 'folder'::"ItemType"
          AND "deleted_at" IS NULL
          AND data @> jsonb_build_object('childItemIds', jsonb_build_array(${row.id}::text))
      `;
      for (const p of parents) {
        if (!seen.has(p.id)) {
          queue.push({ ...p, depth: node.depth + 1 });
        }
      }
    }
    return Array.from(merged.values());
  }

  async inheritedSharesForFolder(
    folderId: string,
  ): Promise<ItemShare[]> {
    const collected: ItemShare[] = [];
    const visited = new Set<string>();
    let cur: string | null = folderId;
    while (cur && !visited.has(cur)) {
      visited.add(cur);
      const row: { data: unknown; shares: ItemShare[] } | null =
        await this.prisma.item.findFirst({
          where: { id: cur, type: 'folder', deletedAt: null },
          select: { data: true, shares: true },
        });
      if (!row) break;
      // The folder's own shares always count.
      collected.push(...row.shares);
      // Stop walking if this folder explicitly opts out of inheritance.
      const data = row.data as
        | { inheritsParentShares?: unknown }
        | null;
      if (data && data.inheritsParentShares === false) break;
      // Find the first parent folder that claims this id. Tolerates
      // the multi-parent DAG by picking one parent (first match);
      // good enough for v1.
      const parentRow: { id: string } | null = await this.prisma.$queryRaw<
        Array<{ id: string }>
      >`
        SELECT id FROM "item"
        WHERE type = 'folder'::"ItemType"
          AND "deleted_at" IS NULL
          AND data @> jsonb_build_object('childItemIds', jsonb_build_array(${cur}::text))
        LIMIT 1
      `.then((rows) => rows[0] ?? null);
      cur = parentRow?.id ?? null;
    }
    return collected;
  }

  /**
   * Compute the effective row scope for a caller against an item's
   * features (#40). Returns `'all'` when the caller is the owner, an
   * org admin, or holds at least one matching share with rowScope
   * 'all'; returns `'own'` only when every matching share narrows to
   * the caller's own rows. Pairs with the layer-level
   * `editingPolicy` (#41) which can tighten further but never loosen.
   *
   * The semantics are deliberately permissive: any single 'all'
   * grant beats every 'own' grant the user might also have, so a
   * user who has both a narrow per-team share AND a broader
   * org-level read is not accidentally locked into 'own'.
   *
   * Caller-supplied `shares` should be the item's full share list;
   * filtering down to matches happens here.
   */
  effectiveRowScope(
    user: AuthUser,
    item: Item,
    shares: ItemShare[] = [],
    layerPolicy: 'all-rows' | 'own-rows-only' = 'all-rows',
  ): 'all' | 'own' {
    // Owner / admin / public / org-public all bypass row scoping
    // entirely. This matches the geoLimitFor exemptions and keeps
    // the safety-valve invariant: admins always see everything.
    // The layer-level editingPolicy does NOT change this -- the
    // safety valve always wins.
    if (item.ownerId === user.id) return 'all';
    if (user.orgRole === 'admin' && item.orgId === user.orgId) return 'all';
    if (item.access === 'public') return 'all';
    if (item.access === 'org' && item.orgId === user.orgId) return 'all';

    // Layer-level baseline (#41). 'own-rows-only' tightens every
    // matching share regardless of its own rowScope; per-share
    // rowScope can never loosen the layer baseline.
    if (layerPolicy === 'own-rows-only') return 'own';

    const matching = shares.filter((s) => this.shareMatches(user, s));
    if (matching.length === 0) {
      // No matching share + non-public + non-org. Caller cannot see
      // the item at all; the visibility check upstream should have
      // rejected before we got here. Return 'own' as the safest
      // fallback: the SQL filter will then yield zero rows for any
      // caller-id mismatch.
      return 'own';
    }
    // Any single matching share with rowScope 'all' (default)
    // upgrades the effective scope to 'all'.
    for (const s of matching) {
      const sc = (s as ItemShare & { rowScope?: 'all' | 'own' }).rowScope;
      if (!sc || sc === 'all') return 'all';
    }
    return 'own';
  }

  /**
   * Build a Prisma `where` clause selecting only items the user can see.
   * Used for list queries so we don't fetch + filter in memory.
   *
   * Trashed items (deletedAt != null) are excluded by default. Use
   * `includeTrashed` for the trash view specifically; the caller is
   * responsible for adding an explicit `deletedAt: { not: null }` filter
   * when it wants only the trash.
   */
  visibleWhere(
    user: AuthUser,
    opts: { includeTrashed?: boolean } = {},
  ): Prisma.ItemWhereInput {
    // Admin short-circuit: an org admin's "visible" set is every item
    // in their org, regardless of sharing. Matches the point-check in
    // canRead so list queries and per-item checks agree.
    if (user.orgRole === 'admin') {
      const adminAccess: Prisma.ItemWhereInput = { orgId: user.orgId };
      if (opts.includeTrashed) return adminAccess;
      return { AND: [adminAccess, { deletedAt: null }] };
    }

    const principalConditions: Prisma.ItemShareWhereInput[] = [
      { principalType: 'user', principalId: user.id },
    ];
    if (user.groupIds.length > 0) {
      principalConditions.push({
        principalType: 'group',
        principalId: { in: user.groupIds },
      });
    }
    const access: Prisma.ItemWhereInput = {
      OR: [
        { ownerId: user.id },
        { access: 'public' },
        { access: 'org', orgId: user.orgId },
        { shares: { some: { OR: principalConditions } } },
      ],
    };
    if (opts.includeTrashed) return access;
    return { AND: [access, { deletedAt: null }] };
  }
}
