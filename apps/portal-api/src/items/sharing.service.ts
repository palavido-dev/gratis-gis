// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable } from '@nestjs/common';
import type { Item, ItemShare } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { GeoJsonGeometry } from '@gratis-gis/engine';

import type { AuthUser } from '../auth/auth-sync.service.js';
import {
  CLOSED_GEO_LIMIT,
  isClosedGeoLimit,
} from '../common/closed-geo-limit.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { buildEntityStore } from '../policy/entity-store.js';

export type FeatureScopeAction = 'read' | 'edit';

/** A caller's resolved scope on one data layer. */
export interface FeatureScope {
  /** GeoJSON clip in EPSG:4326, or null for no geographic limit. */
  geoLimit: unknown | null;
  /** 'own' limits the caller to rows they created. */
  rowScope: 'all' | 'own';
  /** The caller, for the own-rows predicate. */
  userId: string;
}

/** The engine's filter options for a resolved scope. */
export interface FeatureScopeFilter {
  geoLimit?: GeoJsonGeometry;
  ownRowsOnly?: { userId: string };
}

/**
 * Turn a resolved scope into the `geoLimit` / `ownRowsOnly` options
 * every engine read takes. Spread it into the options object so an
 * unscoped caller adds no keys at all.
 */
export function featureScopeFilter(scope: FeatureScope): FeatureScopeFilter {
  const out: FeatureScopeFilter = {};
  if (scope.geoLimit) out.geoLimit = scope.geoLimit as GeoJsonGeometry;
  if (scope.rowScope === 'own') out.ownRowsOnly = { userId: scope.userId };
  return out;
}

/**
 * SQL predicates for a resolved scope over a legacy per-item feature
 * table (`fs_<id>`, columns `geom` and `created_by`). Values go into
 * `params` as bound parameters; the returned strings reference them
 * by position, so pass the same array to the query.
 */
export function legacyTableScopeConditions(
  scope: FeatureScope,
  params: unknown[],
): string[] {
  const out: string[] = [];
  if (scope.geoLimit && isClosedGeoLimit(scope.geoLimit)) {
    // A configured boundary that cannot be resolved: no rows.
    out.push('false');
  } else if (scope.geoLimit) {
    params.push(JSON.stringify(scope.geoLimit));
    out.push(
      `geom IS NOT NULL AND ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON($${params.length}::text), 4326))`,
    );
  }
  if (scope.rowScope === 'own') {
    params.push(scope.userId);
    out.push(`created_by = $${params.length}::uuid`);
  }
  return out;
}

/** True when the scope narrows the caller in any way. */
export function isScopeLimited(scope: FeatureScope): boolean {
  return scope.geoLimit !== null || scope.rowScope === 'own';
}

/**
 * Single source of truth for item access decisions. The four
 * point-checks (canRead / canEdit / canDownload / canAdmin) delegate
 * to PolicyService.check (Cedar) since Phase B; the policy text in
 * `apps/portal-api/src/policy/policy.service.ts:DEFAULT_POLICY_TEXT`
 * encodes the same behaviour the imperative versions used to
 * implement, so the public function shapes stay stable for callers.
 *
 * The geo-limit / row-scope / list-query helpers
 * (`geoLimitFor`, `effectiveRowScope`, `visibleWhere`) stay
 * imperative for v1: they return geometry / set / SQL respectively
 * and don't have a clean Cedar boolean shape. Phase C
 * (lens-level custom policies) revisits them once we have the
 * geometry-aware extension wired in.
 *
 * See `docs/architecture/cedar-policy-integration.md` and
 * `/docs/data-model.md` for the higher-level model.
 */
@Injectable()
export class SharingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
  ) {}

  canRead(user: AuthUser, item: Item, shares: ItemShare[] = []): boolean {
    return this.policyAllows(user, item, shares, 'read');
  }

  canEdit(user: AuthUser, item: Item, shares: ItemShare[] = []): boolean {
    return this.policyAllows(user, item, shares, 'edit');
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
    return this.policyAllows(user, item, shares, 'download');
  }

  /**
   * Owner / org-admin only. The "admin" share permission tier
   * deliberately does NOT promote a recipient into canAdmin (which
   * gates ownership reassignment + purge). To grant those, transfer
   * ownership instead.
   */
  canAdmin(user: AuthUser, item: Item): boolean {
    return this.policyAllows(user, item, [], 'admin');
  }

  /**
   * Build the Cedar entity store for this (user, item, shares) tuple
   * and dispatch the named action through PolicyService. Pulled into
   * one place so all four canX methods agree on the entity layout
   * and on how to handle the inevitable Cedar runtime errors.
   */
  private policyAllows(
    user: AuthUser,
    item: Item,
    shares: readonly ItemShare[],
    action: 'read' | 'edit' | 'download' | 'admin',
  ): boolean {
    const result = this.policy.check({
      principal: { type: 'User', id: user.id },
      action: { type: 'Action', id: action },
      resource: { type: 'Item', id: item.id },
      entities: buildEntityStore({ user, item, shares }),
    });
    return result.decision === 'allow';
  }

  /**
   * Resolve the geographic restriction that applies to `user` on
   * `item`. Returns a GeoJSON geometry (Polygon, MultiPolygon, or
   * GeometryCollection) when the user is limited to a sub-region, or
   * `null` when they have unrestricted access.
   *
   * Semantics (matches the product-level design in docs/data-model.md):
   *   - Owners and admins bypass geo limits entirely.
   *   - A user reaching the item via `access: public` is subject to
   *     the item's `publicGeoBoundaryId` if set (#80); same for
   *     same-org viewers reaching via `access: org` and
   *     `orgGeoBoundaryId`. Tier limits are real access control: the
   *     read path actually clips features to the polygon, distinct
   *     from the map-level "default view scope" tracked under #79.
   *     A tier with no boundary attached is unrestricted (pre-#80
   *     semantics).
   *   - When reading via an explicit `ItemShare`, the user's effective
   *     access through that path is the share's geo polygon (or
   *     unrestricted if the share has no polygon).
   *   - A user reachable through MORE THAN ONE access path (e.g. an
   *     org viewer who also has an explicit per-user share) gets the
   *     UNION of every reachable path's polygon. If any reachable
   *     path is unrestricted, the user has full access; the more
   *     permissive path wins. This matches how Cedar policy grants
   *     compose -- multiple "allow" decisions don't cancel each
   *     other out.
   *   - A matching share's clip is whichever of its two columns is
   *     populated: the inline `geoLimit` GeoJSON, or the geometry of
   *     the `geoBoundaryId` it references. If the referenced boundary
   *     no longer exists (or is the wrong item type, or has no
   *     geometry yet), that path grants nothing: it adds no polygon,
   *     and if no other path reaches the item the result is the
   *     closed limit. Trashing a boundary must never widen access.
   *     Tier boundaries follow the same rule.
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
    action: FeatureScopeAction = 'read',
  ): Promise<unknown | null> {
    if (item.ownerId === user.id) return null;
    if (user.orgRole === 'admin' && item.orgId === user.orgId) return null;

    // Each access path the user reaches the item through contributes
    // either a polygon or "unrestricted." If any contributes
    // unrestricted, the union is unrestricted (more permissive path
    // wins). Otherwise the union of polygons is the effective limit.
    let hasUnrestrictedPath = false;
    // Set when a path references a boundary that cannot be resolved.
    // Such a path grants nothing, so if no other path opens the item
    // the result is the closed limit, never "no clip".
    let boundaryClosed = false;
    const polygons: unknown[] = [];

    // #80: tier-level path. Anonymous viewers reach via 'public';
    // signed-in same-org viewers reach via 'org'. Each tier may
    // have its own boundary item attached. If the tier has no
    // boundary, this path is unrestricted (matches pre-#80 semantics
    // exactly; the early-return-null lines this replaces are now
    // expressed as "tier path with no boundary => unrestricted").
    // The public and org tiers grant read only, so on a write they
    // are not an access path at all: only shares that grant edit
    // decide the write clip. Counting the tier here used to make
    // every edit share on an org or public layer unrestricted.
    let tierBoundaryId: string | null = null;
    let reachedViaTier = false;
    if (action === 'edit') {
      // No tier path on writes.
    } else if (item.access === 'public') {
      reachedViaTier = true;
      tierBoundaryId =
        (item as Item & { publicGeoBoundaryId?: string | null })
          .publicGeoBoundaryId ?? null;
    } else if (item.access === 'org' && item.orgId === user.orgId) {
      reachedViaTier = true;
      tierBoundaryId =
        (item as Item & { orgGeoBoundaryId?: string | null })
          .orgGeoBoundaryId ?? null;
    }
    if (reachedViaTier && tierBoundaryId === null) {
      hasUnrestrictedPath = true;
    }

    const matching = this.matchingShares(user, shares, action);
    if (!reachedViaTier && matching.length === 0) {
      // No reachable path at all; canRead has already gated the
      // request. Returning null is safe -- an empty predicate stack
      // is still gated by canRead.
      return null;
    }

    // Look up every distinct geoBoundary referenced by any matching
    // share AND the tier boundary in a single round-trip; per-share
    // and per-tier resolution then reads from this map. A boundary
    // that doesn't exist (or isn't a geo_boundary item, or has no
    // geometry yet) just doesn't end up in the map and the path that
    // referenced it is treated as closed below.
    const boundaryIds = new Set<string>();
    if (tierBoundaryId !== null) boundaryIds.add(tierBoundaryId);
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

    if (tierBoundaryId !== null) {
      const geom = boundaryGeoms.get(tierBoundaryId);
      if (geom) polygons.push(geom);
      else boundaryClosed = true;
    }

    for (const s of matching) {
      const ref = (s as ItemShare & { geoBoundaryId?: string | null })
        .geoBoundaryId;
      if (typeof ref === 'string' && ref.length > 0) {
        const geom = boundaryGeoms.get(ref);
        if (geom) polygons.push(geom);
        else boundaryClosed = true;
        continue;
      }
      const inline = (s as ItemShare & { geoLimit?: unknown }).geoLimit;
      if (inline && typeof inline === 'object') polygons.push(inline);
      else hasUnrestrictedPath = true;
    }
    if (hasUnrestrictedPath) return null;
    if (polygons.length === 0) {
      return boundaryClosed ? CLOSED_GEO_LIMIT : null;
    }
    if (polygons.length === 1) return polygons[0];
    return { type: 'GeometryCollection', geometries: polygons };
  }

  /**
   * Shares that put `user` on this item for `action`. A read counts
   * every live share that names the user or one of their groups. A
   * write counts only the shares that grant edit (an `edit` or
   * `admin` permission), so a broader view share cannot loosen the
   * row scope or geo limit an edit share sets.
   */
  private matchingShares(
    user: AuthUser,
    shares: ItemShare[],
    action: FeatureScopeAction,
  ): ItemShare[] {
    return shares.filter(
      (s) =>
        this.shareMatches(user, s) &&
        (action === 'read' ||
          s.permission === 'edit' ||
          s.permission === 'admin'),
    );
  }

  /**
   * The one place a caller's feature scope on a data layer is
   * resolved: the geo limit and the row scope for `action`, with the
   * layer's editing policy applied. Every feature read and write
   * path (features, tiles, aggregates, exports, OGC, attachments,
   * derived layers, AI) takes its clip from here, so a share limit
   * cannot be honoured on one route and skipped on the next.
   */
  async featureScopeFor(
    user: AuthUser,
    item: Item,
    shares: ItemShare[] = [],
    opts: {
      action: FeatureScopeAction;
      layerPolicy?: 'all-rows' | 'own-rows-only';
    },
  ): Promise<FeatureScope> {
    const geoLimit = await this.geoLimitFor(user, item, shares, opts.action);
    const rowScope = this.effectiveRowScope(
      user,
      item,
      shares,
      opts.layerPolicy ?? 'all-rows',
      opts.action,
    );
    return { geoLimit, rowScope, userId: user.id };
  }

  /**
   * True when the caller certainly reads every feature of a layer
   * with this editing policy: no row scope and no geo limit. Sync, so
   * read paths that only hold the item row can use it. It errs toward
   * false: a boundary reference counts as a limit even if the
   * boundary has since been deleted.
   */
  readsAllFeatures(
    user: AuthUser,
    item: Item,
    shares: ItemShare[] = [],
    layerPolicy: 'all-rows' | 'own-rows-only' = 'all-rows',
  ): boolean {
    if (item.ownerId === user.id) return true;
    if (user.orgRole === 'admin' && item.orgId === user.orgId) return true;
    if (this.effectiveRowScope(user, item, shares, layerPolicy, 'read') !== 'all') {
      return false;
    }
    const withTiers = item as Item & {
      publicGeoBoundaryId?: string | null;
      orgGeoBoundaryId?: string | null;
    };
    if (item.access === 'public' && !withTiers.publicGeoBoundaryId) return true;
    if (
      item.access === 'org' &&
      item.orgId === user.orgId &&
      !withTiers.orgGeoBoundaryId
    ) {
      return true;
    }
    return this.matchingShares(user, shares, 'read').some((s) => {
      const share = s as ItemShare & {
        geoBoundaryId?: string | null;
        geoLimit?: unknown;
      };
      return !share.geoBoundaryId && !(share.geoLimit && typeof share.geoLimit === 'object');
    });
  }

  private shareMatches(user: AuthUser, share: ItemShare): boolean {
    // Expired shares grant nothing (#84). The cron sweep eventually
    // deletes them, but request-time enforcement here means even a
    // delayed sweep doesn't leak access.
    if (this.isShareExpired(share)) return false;
    if (share.principalType === 'user') return share.principalId === user.id;
    if (share.principalType === 'group') return user.groupIds.includes(share.principalId);
    return false;
  }

  /** True when the share has an `expires_at` in the past. Shares
   *  with no expiry (the default) always return false. */
  private isShareExpired(share: ItemShare): boolean {
    const expiresAt = (
      share as ItemShare & { expiresAt?: Date | string | null }
    ).expiresAt;
    if (!expiresAt) return false;
    const t = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
    return t.getTime() <= Date.now();
  }

  /**
   * Compute the effective row scope for a caller against an item's
   * features (#40). Returns `'all'` when the caller is the owner, an
   * org admin, or holds at least one matching share with the
   * action's row scope = 'all'; returns `'own'` only when every
   * matching share narrows to the caller's own rows. Pairs with the
   * layer-level `editingPolicy` (#41) which can tighten further but
   * never loosen.
   *
   * #83: the optional `action` arg picks which row-scope column to
   * read for each share -- 'read' uses `rowScope` (the historical
   * single column), 'edit' uses `editRowScope` if non-null and
   * falls back to `rowScope`. So a share at rowScope='all' /
   * editRowScope='own' lets the grantee see every row but only
   * edit their own. Default 'read' keeps callers that don't care
   * about the distinction (read-time only) on the historical
   * behavior with no change.
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
    action: FeatureScopeAction = 'read',
  ): 'all' | 'own' {
    // Owner / admin / public / org-public all bypass row scoping
    // entirely. This matches the geoLimitFor exemptions and keeps
    // the safety-valve invariant: admins always see everything.
    // The layer-level editingPolicy does NOT change this -- the
    // safety valve always wins.
    if (item.ownerId === user.id) return 'all';
    if (user.orgRole === 'admin' && item.orgId === user.orgId) return 'all';
    // The public and org tiers grant read only. On an edit the
    // caller's rights come from an edit share, so the tier must not
    // widen the edit scope: the layer policy and the share's
    // editRowScope still apply on org and public layers.
    if (action === 'read') {
      if (item.access === 'public') return 'all';
      if (item.access === 'org' && item.orgId === user.orgId) return 'all';
    }

    // Layer-level baseline (#41). 'own-rows-only' tightens every
    // matching share regardless of its own rowScope; per-share
    // rowScope can never loosen the layer baseline. Applies to both
    // read and edit: a layer marked own-rows-only narrows every
    // grantee on both axes.
    if (layerPolicy === 'own-rows-only') return 'own';

    const matching = this.matchingShares(user, shares, action);
    if (matching.length === 0) {
      // No matching share + non-public + non-org. Caller cannot see
      // the item at all; the visibility check upstream should have
      // rejected before we got here. Return 'own' as the safest
      // fallback: the SQL filter will then yield zero rows for any
      // caller-id mismatch.
      return 'own';
    }
    // Any single matching share with the action's row scope = 'all'
    // (default) upgrades the effective scope to 'all'. For 'edit',
    // a null editRowScope falls back to the share's rowScope so
    // the historical behavior is preserved on every existing row.
    for (const s of matching) {
      const row = s as ItemShare & {
        rowScope?: 'all' | 'own';
        editRowScope?: 'all' | 'own' | null;
      };
      const sc =
        action === 'edit'
          ? (row.editRowScope ?? row.rowScope)
          : row.rowScope;
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
    // Build the per-share match predicate, then AND in the
    // not-expired filter so a share with `expires_at <= now()`
    // doesn't grant access (#84). Null expiresAt means "never
    // expires" and is the common case, so the OR keeps it cheap.
    const principalConditions: Prisma.ItemShareWhereInput[] = [
      { principalType: 'user', principalId: user.id },
    ];
    if (user.groupIds.length > 0) {
      principalConditions.push({
        principalType: 'group',
        principalId: { in: user.groupIds },
      });
    }
    const notExpired: Prisma.ItemShareWhereInput = {
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    };
    // An org admin sees every item in their org, regardless of
    // sharing, PLUS what any member sees from outside it (public
    // items and shares from other orgs). canRead grants an admin both,
    // so the list must too or the two disagree.
    const access: Prisma.ItemWhereInput = {
      OR: [
        ...(user.orgRole === 'admin' ? [{ orgId: user.orgId }] : []),
        { ownerId: user.id },
        { access: 'public' },
        { access: 'org', orgId: user.orgId },
        {
          shares: {
            some: { AND: [{ OR: principalConditions }, notExpired] },
          },
        },
      ],
    };
    if (opts.includeTrashed) return access;
    return { AND: [access, { deletedAt: null }] };
  }
}
