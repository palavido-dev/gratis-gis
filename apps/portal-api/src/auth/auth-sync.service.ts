// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { OrgRole } from '@prisma/client';
import {
  BUILTIN_BASEMAP_SEEDS,
  PRINT_TEMPLATE_STARTERS,
  STARTERS,
  THEME_STARTERS,
} from '@gratis-gis/shared-types';
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
  /**
   * How this request authenticated. Absent means a Keycloak JWT (the
   * default for every interactive request and every synthesized
   * AuthUser in the workers), so existing code and test factories
   * need no change.
   *
   * `api_key` carries two restrictions that a browser session does
   * not, both enforced in the auth layer rather than in services:
   * keys are refused on /admin/* by AdminGuard, and a read-only key
   * is refused on unsafe HTTP methods by JwtAuthGuard. See #219.
   */
  authKind?: 'jwt' | 'api_key';
  /** Set only when `authKind === 'api_key'`; drives the method gate. */
  apiKeyReadOnly?: boolean;
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
   * Per-org in-flight promise. When a user signs in, NextAuth and the
   * portal land make multiple parallel requests against the api; each
   * one runs ensureBuiltinBasemaps in isolation, all see the same
   * empty-state SELECT, and all INSERT the full BUILTIN set. Result:
   * one row per (basemap, request) -- on first sign-in we observed
   * 3x copies of every seed.
   *
   * Coalescing by org turns N parallel callers into one in-flight
   * INSERT; the others await the same Promise and short-circuit on
   * the now-populated basemapSeedChecked Set. Cleared once the inner
   * promise resolves (success or failure) so a transient DB error
   * doesn't permanently disable seeding.
   */
  private readonly basemapSeedInFlight = new Map<string, Promise<void>>();

  /**
   * #22: per-process cache + in-flight promise for the parallel
   * "every org gets the four starter app templates" seeding pass.
   * Same coalescing pattern as the basemap seeder above.  Resets
   * on process restart so a newly-added starter (or a renamed
   * one) gets re-checked next deploy.
   */
  private readonly appTemplateSeedChecked = new Set<string>();
  private readonly appTemplateSeedInFlight = new Map<string, Promise<void>>();

  /**
   * #22: parallel coalesced seeding for the five starter theme
   * items.  Same pattern as the basemap + app-template seeders.
   */
  private readonly themeSeedChecked = new Set<string>();
  private readonly themeSeedInFlight = new Map<string, Promise<void>>();

  /**
   * #101: parallel coalesced seeding for the five starter print
   * template items.  Same coalescing pattern as the others.
   */
  private readonly printTemplateSeedChecked = new Set<string>();
  private readonly printTemplateSeedInFlight = new Map<string, Promise<void>>();

  /**
   * Per-process cache of `token sub -> last time we wrote
   * lastSeenAt`. Throttles the lastSeenAt write to once per
   * LAST_SEEN_THROTTLE_MS so the stable-state cost of an
   * authenticated request is one SELECT (the user read) and no
   * write at all. The user's actual freshness signal is bounded
   * above by this throttle, which is fine for housekeeping (we
   * measure stale users in days, not seconds).
   *
   * Keyed by the JWT `sub`, the identifier available before the row
   * is read. It must be the SAME key on read and write: an earlier
   * version read by sub but recorded by local user id, so for
   * seeded users (whose local id predates Keycloak and differs from
   * sub) the throttle never engaged and every request wrote the row
   * anyway.
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
    const now = Date.now();
    const lastWrite = this.lastSeenWrittenAt.get(claims.sub) ?? 0;
    const writeLastSeen =
      now - lastWrite >= AuthSyncService.LAST_SEEN_THROTTLE_MS;

    // #365: some Keycloak users (the public-preview demo accounts in
    // particular) are provisioned without an email attribute and the
    // token therefore has no `email` claim. The local `user.email`
    // column is non-nullable, so passing through `undefined` would
    // crash the write with PrismaClientValidationError on every
    // authed request from that user. Synthesize a deterministic
    // placeholder so the write always succeeds; if Keycloak later
    // starts sending a real email the next request overwrites it.
    const email =
      claims.email ?? `${claims.preferred_username}@local.gratisgis`;

    // Read-first sync. The previous shape was an unconditional
    // upsert whose update branch rewrote email/fullName/orgRole/
    // orgId on EVERY authenticated request even when nothing had
    // changed: pure WAL churn, plus row-lock serialization when a
    // burst of parallel requests (a 30-tile map load) all queued on
    // the same user row. Steady state is now read-only: when the
    // row exists, the claims match, and the lastSeenAt throttle
    // window has not elapsed, no write happens at all. A write only
    // fires when the profile actually changed in Keycloak or the
    // throttle expired, and then only with the fields that need it.
    const existing = await this.prisma.user.findUnique({
      where: { username: claims.preferred_username },
    });
    // fullName only counts as changed when the token carries a name:
    // Prisma skips undefined fields, so the old upsert also left
    // fullName untouched for tokens without a `name` claim.
    const claimsChanged =
      existing === null ||
      existing.email !== email ||
      (claims.name !== undefined && existing.fullName !== claims.name) ||
      existing.orgRole !== normalisedRole ||
      existing.orgId !== org.id;

    const user =
      existing !== null && !claimsChanged && !writeLastSeen
        ? existing
        : await this.prisma.user.upsert({
            // Kept as an upsert rather than create-or-update so the
            // first-sign-in stampede (NextAuth + portal SSR firing in
            // parallel) can't race two creates into a unique-violation
            // on username; the race loser just lands in the update
            // branch.
            where: { username: claims.preferred_username },
            update: {
              ...(claimsChanged
                ? {
                    email,
                    fullName: claims.name,
                    orgRole: normalisedRole,
                    orgId: org.id,
                  }
                : {}),
              ...(writeLastSeen ? { lastSeenAt: new Date() } : {}),
            },
            create: {
              // New users (not seeded) adopt Keycloak's sub as their local id, so
              // the two systems stay aligned when there's no prior record.
              id: claims.sub,
              orgId: org.id,
              username: claims.preferred_username,
              email,
              fullName: claims.name,
              orgRole: normalisedRole,
              lastSeenAt: new Date(),
            },
          });
    if (writeLastSeen) {
      // Record the write so the throttle holds for the next minute.
      // Whenever writeLastSeen is true a write definitely happened
      // (either the update's lastSeenAt or the create's), including
      // for brand-new users, whose unseen map entry always makes
      // writeLastSeen true on their first request in this process.
      this.lastSeenWrittenAt.set(claims.sub, now);
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
    //
    // Parallel callers (NextAuth + portal-web SSR all firing on first
    // sign-in) share a single in-flight promise so we don't trigger N
    // concurrent INSERTs that each see the same empty state. The first
    // arrival kicks off the work; everyone else awaits the same
    // Promise. Once it settles we mark the org as checked and drop the
    // in-flight entry so a transient failure doesn't permanently
    // disable seeding.
    if (!this.basemapSeedChecked.has(org.id)) {
      let inFlight = this.basemapSeedInFlight.get(org.id);
      if (!inFlight) {
        inFlight = (async () => {
          try {
            await this.ensureBuiltinBasemaps(org.id, user.id);
            this.basemapSeedChecked.add(org.id);
          } finally {
            this.basemapSeedInFlight.delete(org.id);
          }
        })();
        this.basemapSeedInFlight.set(org.id, inFlight);
      }
      await inFlight;
    }

    // #22: same coalesced-seeding pattern for the four starter
    // app_template items.  Idempotent (skipped per-process once
    // an org is confirmed; idempotent against the DB via the
    // seed_kind unique check inside the seeder).
    if (!this.appTemplateSeedChecked.has(org.id)) {
      let inFlight = this.appTemplateSeedInFlight.get(org.id);
      if (!inFlight) {
        inFlight = (async () => {
          try {
            await this.ensureBuiltinAppTemplates(org.id, user.id);
            this.appTemplateSeedChecked.add(org.id);
          } finally {
            this.appTemplateSeedInFlight.delete(org.id);
          }
        })();
        this.appTemplateSeedInFlight.set(org.id, inFlight);
      }
      await inFlight;
    }

    // #22: the same dance for the five starter theme items.
    if (!this.themeSeedChecked.has(org.id)) {
      let inFlight = this.themeSeedInFlight.get(org.id);
      if (!inFlight) {
        inFlight = (async () => {
          try {
            await this.ensureBuiltinThemes(org.id, user.id);
            this.themeSeedChecked.add(org.id);
          } finally {
            this.themeSeedInFlight.delete(org.id);
          }
        })();
        this.themeSeedInFlight.set(org.id, inFlight);
      }
      await inFlight;
    }

    // #101: the same dance for the five starter print template
    // items.
    if (!this.printTemplateSeedChecked.has(org.id)) {
      let inFlight = this.printTemplateSeedInFlight.get(org.id);
      if (!inFlight) {
        inFlight = (async () => {
          try {
            await this.ensureBuiltinPrintTemplates(org.id, user.id);
            this.printTemplateSeedChecked.add(org.id);
          } finally {
            this.printTemplateSeedInFlight.delete(org.id);
          }
        })();
        this.printTemplateSeedInFlight.set(org.id, inFlight);
      }
      await inFlight;
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

  /**
   * #22: For each built-in starter app template, insert an
   * `app_template` item row if the org doesn't already have one
   * with that `seed_kind`.  Idempotent: if the admin previously
   * deleted a starter, this will not re-create it (the housekeeping
   * "Restore starter templates" button is the explicit way to bring
   * them back).  Idempotent on first-run: the seed_kind check
   * prevents duplicates if two processes race.
   *
   * Each starter's CustomAppData blueprint is captured at seed
   * time, so editing the seed function and redeploying does NOT
   * mutate existing items.  Org admins own their starter items
   * outright and can edit them freely.
   */
  private async ensureBuiltinAppTemplates(
    orgId: string,
    fallbackOwnerId: string,
  ): Promise<void> {
    const existing = await this.prisma.item.findMany({
      where: { orgId, type: 'app_template', seedKind: { not: null } },
      select: { seedKind: true },
    });
    const have = new Set<string>();
    for (const row of existing) {
      if (row.seedKind) have.add(row.seedKind);
    }
    const missing = STARTERS.filter((s) => !have.has(s.kind));
    if (missing.length === 0) return;

    // Prefer the org's first admin so the seed items match the
    // ownership model existing orgs would have on a manual create.
    // Fall back to the signed-in user only when the org has no
    // admin yet (very early in org bootstrap).
    const admin = await this.prisma.user.findFirst({
      where: { orgId, orgRole: 'admin' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    const ownerId = admin?.id ?? fallbackOwnerId;

    await this.prisma.item.createMany({
      data: missing.map((starter) => ({
        orgId,
        ownerId,
        type: 'app_template' as const,
        title: starter.label,
        description: starter.description,
        tags: ['built-in', ...starter.tags],
        data: starter.seed() as unknown as object,
        access: 'org' as const,
        seedKind: starter.kind,
      })),
      // Belt-and-suspenders with the partial unique index on
      // (org_id, type, seed_kind).  If a sibling replica wins the
      // INSERT race for any starter, the conflicting row is
      // silently skipped here instead of the whole createMany
      // failing.  The other replica still owns the row, which is
      // what we want.
      skipDuplicates: true,
    });
  }

  /**
   * #22: For each built-in theme starter, insert a `theme` item
   * row if the org doesn't already have one with that seed_kind.
   * Idempotent on first run via the seed_kind check.  Admin can
   * later delete one without it coming back automatically (the
   * housekeeping "Restore starter themes" button is the explicit
   * way).
   */
  private async ensureBuiltinThemes(
    orgId: string,
    fallbackOwnerId: string,
  ): Promise<void> {
    const existing = await this.prisma.item.findMany({
      where: { orgId, type: 'theme', seedKind: { not: null } },
      select: { seedKind: true },
    });
    const have = new Set<string>();
    for (const row of existing) {
      if (row.seedKind) have.add(row.seedKind);
    }
    const missing = THEME_STARTERS.filter((s) => !have.has(s.kind));
    if (missing.length === 0) return;

    const admin = await this.prisma.user.findFirst({
      where: { orgId, orgRole: 'admin' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    const ownerId = admin?.id ?? fallbackOwnerId;

    await this.prisma.item.createMany({
      data: missing.map((starter) => ({
        orgId,
        ownerId,
        type: 'theme' as const,
        title: starter.label,
        description: starter.description,
        tags: ['built-in'],
        data: {
          version: 1,
          swatch: starter.swatch,
          tokens: starter.tokens,
        } as unknown as object,
        access: 'org' as const,
        seedKind: starter.kind,
      })),
      // See ensureBuiltinAppTemplates for the rationale; same
      // cross-replica race risk applies here.
      skipDuplicates: true,
    });
  }

  /**
   * #101: For each built-in print template starter, insert a
   * `print_template` item row if the org doesn't already have one
   * with that seed_kind.  Same idempotent + restore-via-housekeeping
   * pattern as the theme + app_template seeders.
   */
  private async ensureBuiltinPrintTemplates(
    orgId: string,
    fallbackOwnerId: string,
  ): Promise<void> {
    const existing = await this.prisma.item.findMany({
      where: { orgId, type: 'print_template', seedKind: { not: null } },
      select: { seedKind: true },
    });
    const have = new Set<string>();
    for (const row of existing) {
      if (row.seedKind) have.add(row.seedKind);
    }
    const missing = PRINT_TEMPLATE_STARTERS.filter((s) => !have.has(s.kind));
    if (missing.length === 0) return;

    const admin = await this.prisma.user.findFirst({
      where: { orgId, orgRole: 'admin' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    const ownerId = admin?.id ?? fallbackOwnerId;

    await this.prisma.item.createMany({
      data: missing.map((starter) => ({
        orgId,
        ownerId,
        type: 'print_template' as const,
        title: starter.label,
        description: starter.description,
        tags: ['built-in', ...starter.tags],
        data: starter.seed() as unknown as object,
        access: 'org' as const,
        seedKind: starter.kind,
      })),
      skipDuplicates: true,
    });
  }
}
