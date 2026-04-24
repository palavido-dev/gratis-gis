import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { OrgRole } from '@prisma/client';
import { BUILTIN_BASEMAP_SEEDS } from '@gratis-gis/shared-types';
import { PrismaService } from '../prisma/prisma.service.js';
import type { KeycloakClaims } from './jwt.strategy.js';
import {
  effectiveCapabilities,
  type CapabilityKey,
} from './capabilities.js';

export interface AuthUser {
  id: string;
  orgId: string;
  username: string;
  email: string;
  orgRole: OrgRole;
  /** Group IDs the user belongs to, resolved at request time. */
  groupIds: string[];
  /**
   * Effective capability set for this request, computed by combining
   * the role baseline with any per-user overrides from
   * `user_capability_override`. Use `hasCapability(user, ...)` from
   * `auth/capabilities.ts` rather than reading this directly so the
   * helper picks up unknown-key safety and stays the only place that
   * does the lookup.
   */
  capabilities: ReadonlySet<CapabilityKey>;
}

/**
 * On every request the JWT strategy calls `upsertFromClaims` to keep the
 * local `user` table in sync with Keycloak, then resolves the user's group
 * memberships so authorization checks are cheap downstream.
 */
@Injectable()
export class AuthSyncService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertFromClaims(claims: KeycloakClaims): Promise<AuthUser> {
    const orgSlug = claims.org;
    if (!orgSlug) {
      throw new UnauthorizedException('JWT is missing required "org" claim');
    }
    // Backward-compat: the role was renamed publisher -> contributor
    // (see migration 20260424230000) but existing JWTs minted before
    // the Keycloak realm was re-imported still carry 'publisher'.
    // Translate at the edge so a stale token doesn't crash the upsert
    // with an invalid enum value. Safe to remove after every user has
    // signed out + back in at least once against the updated realm.
    // Cast to string for the comparison because the claim type no
    // longer lists 'publisher' — if the runtime value matches we
    // still want to coerce it.
    const rawRole = claims.org_role as string | undefined;
    const normalisedRole: OrgRole =
      rawRole === 'publisher'
        ? 'contributor'
        : ((rawRole as OrgRole | undefined) ?? 'viewer');

    const org = await this.prisma.organization.upsert({
      where: { slug: orgSlug },
      update: {},
      create: { slug: orgSlug, name: orgSlug },
    });

    // We key on `username` rather than Keycloak's `sub`. The local user.id is
    // our own stable identifier (possibly seeded or provisioned before the user
    // ever touched Keycloak), while `sub` is the IdP's opaque id. Keying on
    // username means a seeded `alice` and a Keycloak-authenticated `alice`
    // resolve to the same row, and downstream FKs (items, group memberships)
    // remain stable even if the IdP is swapped out or the sub changes.
    // After both the org and the user exist (the user upsert happens
    // below), make sure the org has its built-in basemap items seeded.
    // Seeding is idempotent: the helper only inserts rows for
    // seededKey markers that are missing. Kept on the auth-sync path
    // so any first sign-in against a fresh org immediately gets a
    // working basemap library without a separate admin step.
    // We run it AFTER the user upsert below so the owner assignment
    // can reference a real user.
    const user = await this.prisma.user.upsert({
      where: { username: claims.preferred_username },
      update: {
        email: claims.email,
        fullName: claims.name,
        orgRole: normalisedRole,
        orgId: org.id,
        // Every authenticated request touches this record so the
        // housekeeping page can tell "user who last signed in 8
        // months ago" apart from "user who's active this week".
        // Writing on every request is cheap (same upsert that was
        // already happening) and simpler than a separate heartbeat
        // path.
        lastSeenAt: new Date(),
      },
      create: {
        // New users (not seeded) adopt Keycloak's sub as their local id, so
        // the two systems stay aligned when there's no prior record.
        id: claims.sub,
        orgId: org.id,
        username: claims.preferred_username,
        email: claims.email,
        fullName: claims.name,
        orgRole: normalisedRole,
        lastSeenAt: new Date(),
      },
    });

    // Seed built-in basemap items if this org is missing any. Cheap
    // guard: only inserts for seededKey markers that are not already
    // present, so the common case (org already seeded) is one SELECT
    // that returns five rows and no writes.
    await this.ensureBuiltinBasemaps(org.id, user.id);

    // Exclude memberships whose group is in the trash. Otherwise an item
    // shared to a soft-deleted group would still match this user's
    // effective groupIds and grant read access -- which would defeat
    // the purpose of moving the group to the recycle bin.
    const memberships = await this.prisma.groupMember.findMany({
      where: { userId: user.id, group: { deletedAt: null } },
      select: { groupId: true },
    });

    // Per-user capability overrides. Joined into AuthUser as the
    // effective capability set so `hasCapability(user, ...)` is a
    // hot-path Set lookup rather than a database round-trip.
    const overrides = await this.prisma.userCapabilityOverride.findMany({
      where: { userId: user.id },
      select: { capability: true, enabled: true },
    });
    const capabilities = effectiveCapabilities(user.orgRole, overrides);

    return {
      id: user.id,
      orgId: user.orgId,
      username: user.username,
      email: user.email,
      orgRole: user.orgRole,
      groupIds: memberships.map((m) => m.groupId),
      capabilities,
    };
  }

  /**
   * For each built-in basemap seed, insert an item row if the org
   * doesn't already have one with that `seededKey`. The caller passes
   * `fallbackOwnerId` (the user who just signed in) to use when the
   * org has no admin yet; if an admin exists, they own the seed
   * instead, matching the migration's behaviour for existing orgs.
   */
  private async ensureBuiltinBasemaps(
    orgId: string,
    fallbackOwnerId: string,
  ): Promise<void> {
    const existingKeys = await this.prisma.item.findMany({
      where: { orgId, type: 'basemap' },
      select: { data: true },
    });
    const have = new Set<string>();
    for (const row of existingKeys) {
      const key = (row.data as { seededKey?: unknown } | null)?.seededKey;
      if (typeof key === 'string') have.add(key);
    }
    const missing = BUILTIN_BASEMAP_SEEDS.filter(
      (s) => !have.has(s.seededKey),
    );
    if (missing.length === 0) return;

    const admin = await this.prisma.user.findFirst({
      where: { orgId, orgRole: 'admin' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    const ownerId = admin?.id ?? fallbackOwnerId;

    await this.prisma.item.createMany({
      data: missing.map((seed) => ({
        orgId,
        ownerId,
        type: 'basemap' as const,
        title: seed.title,
        description: seed.description,
        tags: ['built-in'],
        data: {
          version: 1,
          kind: 'tile-url',
          tileUrl: seed.tileUrl,
          attribution: seed.attribution,
          seededKey: seed.seededKey,
        },
        access: 'org' as const,
      })),
    });
  }
}
