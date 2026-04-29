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
  /**
   * Org slug -- the human-readable identifier we use as the value of
   * the Keycloak `org` user-attribute and as the JWT `org` claim.
   * Carry it on AuthUser so anything that mints downstream identity
   * (e.g. admin invite, service tokens) reaches for the slug rather
   * than the UUID. Passing the UUID would re-trigger the phantom-org
   * bug where auth-sync upserts a brand-new org keyed on the UUID
   * because no slug matches.
   */
  orgSlug: string;
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

  /**
   * Per-process cache of orgs we've already confirmed have all the
   * built-in basemap seeds. Once a process has verified an org once,
   * we skip the SELECT on every subsequent request from that org's
   * users. Reset on process restart so a freshly-introduced seed in
   * BUILTIN_BASEMAP_SEEDS gets seeded the next deploy.
   */
  private readonly basemapSeedChecked = new Set<string>();

  /**
   * Per-process cache of `userId -> last time we wrote lastSeenAt`.
   * Throttles the UPDATE to once per LAST_SEEN_THROTTLE_MS so the
   * stable-state cost of an authenticated request is one SELECT
   * (the user upsert) and not one UPDATE every time. The user's
   * actual freshness signal is bounded above by this throttle, which
   * is fine for housekeeping (we measure stale users in days, not
   * seconds).
   */
  private readonly lastSeenWrittenAt = new Map<string, number>();
  private static readonly LAST_SEEN_THROTTLE_MS = 60_000;

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
    // longer lists 'publisher': if the runtime value matches we
    // still want to coerce it.
    const rawRole = claims.org_role as string | undefined;
    const normalisedRole: OrgRole =
      rawRole === 'publisher'
        ? 'contributor'
        : ((rawRole as OrgRole | undefined) ?? 'viewer');

    // Defense against the admin-invite bug where the new user's `org`
    // attribute was historically set to the inviter's UUID instead of
    // their slug. If we see a UUID-shaped value, prefer looking up
    // the existing org by id rather than minting a phantom org with
    // slug = UUID, name = UUID. The invite path is fixed (we now
    // pass slug, not id), but stray Keycloak users from before the
    // fix would otherwise create garbage orgs on first login.
    const looksLikeUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        orgSlug,
      );
    let org = looksLikeUuid
      ? await this.prisma.organization.findUnique({ where: { id: orgSlug } })
      : null;
    if (!org) {
      org = await this.prisma.organization.upsert({
        where: { slug: orgSlug },
        update: {},
        create: { slug: orgSlug, name: orgSlug },
      });
    }

    // We key on `username` rather than Keycloak's `sub`. The local user.id is
    // our own stable identifier (possibly seeded or provisioned before the user
    // ever touched Keycloak), while `sub` is the IdP's opaque id. Keying on
    // username means a seeded `admin` and a Keycloak-authenticated `admin`
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
    // Decide whether we should refresh `lastSeenAt` on this request.
    // We rate-limit it to once per LAST_SEEN_THROTTLE_MS per user so
    // hot-path auth doesn't write to the user row on every API call.
    // The `findUnique` + `update` split lets us skip the UPDATE when
    // the throttle is active; the user upsert otherwise still happens
    // unconditionally since a brand-new user always needs to be
    // created and a returning user occasionally needs a profile sync
    // (email / name / role changed in Keycloak).
    const now = Date.now();
    const lastWrite = this.lastSeenWrittenAt.get(claims.sub) ?? 0;
    const writeLastSeen =
      now - lastWrite >= AuthSyncService.LAST_SEEN_THROTTLE_MS;

    const user = await this.prisma.user.upsert({
      where: { username: claims.preferred_username },
      update: {
        email: claims.email,
        fullName: claims.name,
        orgRole: normalisedRole,
        orgId: org.id,
        // Throttled per-process: most requests skip writing this and
        // just leave the previous timestamp in place. The housekeeping
        // page measures staleness in days so a 60s lag is irrelevant
        // there but cuts ~1 UPDATE per request out of the auth hot
        // path. lastSeenAt is still ALWAYS set on the create branch.
        ...(writeLastSeen ? { lastSeenAt: new Date() } : {}),
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
    if (writeLastSeen) {
      // Record the write so the throttle holds for the next minute.
      // We also record a write on the create path so a brand-new user
      // doesn't get a redundant update on their second request.
      this.lastSeenWrittenAt.set(user.id, now);
    } else if (lastWrite === 0) {
      // First time we've seen this user in this process: seed the
      // throttle map so any prior write counts forward. The DB write
      // happened (see upsert update branch above gated on the same
      // condition), so set to now.
      this.lastSeenWrittenAt.set(user.id, now);
    }

    // Auto-disable enforcement (#85). When auto_disable_at is in
    // the past, refuse the request immediately so even a delayed
    // cron sweep can't leak access. The cron flips the Keycloak
    // `enabled` flag in bulk so the next sign-in stops at the SSO
    // gate; in the meantime the local API rejects every call.
    // Org admins are exempt via the admin form so a stray
    // auto_disable_at on an admin account can't lock them out,
    // but we double-gate here in case someone toggled the field
    // directly in the DB.
    if (
      user.autoDisableAt !== null &&
      user.autoDisableAt.getTime() <= Date.now() &&
      user.orgRole !== 'admin'
    ) {
      throw new UnauthorizedException(
        'This account is disabled. Contact your organization admin.',
      );
    }

    // Seed built-in basemap items if this org is missing any. We
    // cache "this org has been verified this process lifetime" in
    // memory so the SELECT only fires once per org per process; this
    // turns ensureBuiltinBasemaps into a no-op for every authenticated
    // request after the first one. New seeds added in a deploy are
    // picked up automatically because the cache is per-process.
    if (!this.basemapSeedChecked.has(org.id)) {
      await this.ensureBuiltinBasemaps(org.id, user.id);
      this.basemapSeedChecked.add(org.id);
    }

    // Exclude memberships whose group is in the trash. Otherwise an item
    // shared to a soft-deleted group would still match this user's
    // effective groupIds and grant read access, which would defeat
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
      orgSlug: org.slug,
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
