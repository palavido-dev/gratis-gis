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
  ): 'all' | 'own' {
    // Owner / admin / public / org-public all bypass row scoping
    // entirely. This matches the geoLimitFor exemptions and keeps
    // the safety-valve invariant: admins always see everything.
    if (item.ownerId === user.id) return 'all';
    if (user.orgRole === 'admin' && item.orgId === user.orgId) return 'all';
    if (item.access === 'public') return 'all';
    if (item.access === 'org' && item.orgId === user.orgId) return 'all';

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
