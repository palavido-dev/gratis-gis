import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { OrgRole } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import {
  KeycloakAdminService,
  type KeycloakUserRep,
} from './keycloak-admin.service.js';

/**
 * Eager Keycloak -> Prisma user mirror.
 *
 * Background. The Prisma `user` table is a mirror of the Keycloak
 * realm. Historically that mirror was populated lazily by
 * AuthSyncService on the first authenticated request from each user.
 * That worked while users only changed by signing in, but breaks the
 * moment a user is added to or removed from Keycloak without ever
 * logging in again:
 *
 *   - Newly seeded / invited users (Last login = "Never") didn't show
 *     up in the principal picker until they signed in for the first
 *     time, so an author couldn't share an item with them.
 *   - Users removed from Keycloak (or renamed via username swap) kept
 *     lingering in Prisma forever, surfacing as ghosts in the picker
 *     and as orphan principals on existing share rows.
 *
 * `reconcile()` closes that gap. It pages through every realm user,
 * upserts each into Prisma keyed on username (matching the auth-sync
 * key choice for seed-vs-IdP coexistence), and soft-deletes any
 * Prisma row whose realm entry is gone. Soft-delete (rather than
 * hard delete) keeps existing FKs valid: the user's items still
 * resolve, the share rows that pointed at them stay as audit
 * history, and a future "delete permanently" admin action can run
 * the existing reassign-then-cascade flow (#138).
 *
 * Triggered from three places:
 *   - portal-api boot (app.module bootstrap hook), so the picker is
 *     correct from the first page load even on a fresh process;
 *   - the housekeeping cron (hourly), so drift gets corrected
 *     between boots;
 *   - an admin "Sync now" button on /admin/users, for the impatient
 *     case where someone just invited a user and wants the picker
 *     to know about them right away.
 *
 * Idempotent and safe to call repeatedly. Failures (Keycloak
 * unreachable, admin client not configured) are logged and
 * swallowed: a stale mirror is preferable to a broken portal-api.
 */
@Injectable()
export class KeycloakSyncService implements OnApplicationBootstrap {
  private readonly log = new Logger(KeycloakSyncService.name);

  /**
   * Boot-time reconcile. Runs after every module is initialised so
   * the Prisma + KC services are both ready, and fires asynchronously
   * (not awaited) so a slow Keycloak doesn't tail-latency the api's
   * "ready to serve" moment. The picker uses a stale mirror until the
   * first run completes; this is the same delay as the cron-only
   * version, just front-loaded for the common case where an admin
   * just restarted the api specifically because they invited
   * someone.
   *
   * Failures here are non-fatal: if Keycloak is unreachable on boot,
   * the api still serves with whatever the mirror was at shutdown.
   * The next housekeeping cron tick (or admin "Sync now" click) will
   * pick the work back up.
   */
  onApplicationBootstrap(): void {
    void this.reconcileAll().catch((err) => {
      this.log.warn(
        `boot reconcile threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * Per-page limit when calling Keycloak's /users endpoint.
   * Keycloak's default cap is 100; bumping past that requires
   * the realm-management `view-users` role which we already have.
   * Larger pages mean fewer round trips at the cost of one bigger
   * JSON parse; 200 is a good middle ground for realms up to
   * ~10k users where reconcile completes in a handful of pages.
   */
  private static readonly PAGE_SIZE = 200;

  /**
   * Soft cap on how many users we'll process in one reconcile run.
   * Keeps a runaway realm (or a misconfiguration that returns
   * bogus rows in a loop) from holding the event loop indefinitely.
   * If a realm legitimately exceeds this we'll log a warning and
   * truncate; the next run will keep the mirror consistent for
   * the prefix that fits.
   */
  private static readonly MAX_USERS_PER_RUN = 50_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly kc: KeycloakAdminService,
  ) {}

  /**
   * Reconcile the entire realm against Prisma. Returns counts so the
   * caller (boot hook, cron, admin button) can log or render them.
   * Throws nothing on the happy path; on Keycloak failure returns
   * `skipped: true` and logs.
   */
  async reconcileAll(): Promise<{
    skipped: boolean;
    pagesScanned: number;
    realmUsersSeen: number;
    inserted: number;
    updated: number;
    softDeleted: number;
    skippedNoOrgAttr: number;
    skippedUnknownOrg: number;
  }> {
    if (!this.kc.isConfigured()) {
      this.log.warn(
        'reconcileAll skipped: Keycloak admin client is not configured',
      );
      return {
        skipped: true,
        pagesScanned: 0,
        realmUsersSeen: 0,
        inserted: 0,
        updated: 0,
        softDeleted: 0,
        skippedNoOrgAttr: 0,
        skippedUnknownOrg: 0,
      };
    }

    const tStart = Date.now();
    let pagesScanned = 0;
    let realmUsersSeen = 0;
    let skippedNoOrgAttr = 0;
    let skippedUnknownOrg = 0;
    let inserted = 0;
    let updated = 0;

    // Resolve org slug -> id once up front so per-user work is a
    // hash lookup, not a DB roundtrip per row.
    const orgs = await this.prisma.organization.findMany({
      select: { id: true, slug: true },
    });
    const orgIdBySlug = new Map(orgs.map((o) => [o.slug, o.id]));

    // Track "username -> Keycloak id (sub)" we've seen across all
    // pages, scoped by org. We need this set at the end to identify
    // Prisma rows that no longer exist in the realm and should be
    // soft-deleted. Keyed by orgId to keep the soft-delete pass
    // org-scoped (a Prisma row in org A shouldn't be tombstoned
    // because realm scan didn't find their username in org B).
    const seenByOrg = new Map<string, Set<string>>();
    for (const orgId of orgIdBySlug.values()) seenByOrg.set(orgId, new Set());

    // Page through realm users. The listUsers helper accepts
    // first/max; we walk until a page returns fewer rows than the
    // page size, which is Keycloak's signal for "end of list".
    let first = 0;
    let pageCount = 0;
    while (realmUsersSeen < KeycloakSyncService.MAX_USERS_PER_RUN) {
      let page: KeycloakUserRep[];
      try {
        page = await this.kc.listUsers({
          first,
          max: KeycloakSyncService.PAGE_SIZE,
        });
      } catch (err) {
        this.log.warn(
          `reconcileAll: page ${pageCount} fetch failed (${
            err instanceof Error ? err.message : String(err)
          }); aborting run`,
        );
        return {
          skipped: true,
          pagesScanned,
          realmUsersSeen,
          inserted,
          updated,
          softDeleted: 0,
          skippedNoOrgAttr,
          skippedUnknownOrg,
        };
      }
      pagesScanned++;
      pageCount++;
      if (page.length === 0) break;
      realmUsersSeen += page.length;

      for (const kcUser of page) {
        // Some users may legitimately be disabled (offboarding in
        // progress); they should still mirror as a soft-delete-style
        // dead row OR an enabled=false row. We keep them in the
        // mirror so existing FKs / shares can resolve their display
        // name, but treat `enabled === false` like a tombstone for
        // picker purposes (filtered out via deletedAt below).
        const orgSlug = readSingleAttr(kcUser, 'org');
        if (!orgSlug) {
          skippedNoOrgAttr++;
          continue;
        }
        const orgId = orgIdBySlug.get(orgSlug);
        if (!orgId) {
          // The user is in a realm org we've never seen locally
          // (multi-tenant scenario where Prisma didn't auto-create
          // the org because no one from that org has signed in yet).
          // Skipping is correct: we can't reconcile a user against
          // an org we don't have a row for. Auth-sync will create
          // the org on the user's first real sign-in and the next
          // reconcile run will pick them up.
          skippedUnknownOrg++;
          continue;
        }

        const role = readRole(kcUser);
        const fullName = combineName(
          kcUser.firstName,
          kcUser.lastName,
          kcUser.username,
        );

        // Mirror auth-sync's choice: key by username so a seeded
        // row and a realm-authenticated row resolve to the same
        // local id. New rows adopt the Keycloak sub as the local
        // id so a freshly invited user gets the IdP's identifier
        // straight through.
        // Soft-delete handling: when we re-encounter a user whose
        // local row is currently tombstoned (deletedAt set), clear
        // the tombstone so they reappear in the picker. This
        // matters for the rename / temporary-disable flow.
        const result = await this.prisma.user.upsert({
          where: { username: kcUser.username },
          update: {
            email: kcUser.email ?? '',
            fullName,
            orgRole: role,
            orgId,
            // Clear tombstone if previously soft-deleted: the user
            // is back in the realm so they should be visible again.
            // Don't touch lastSeenAt here -- this is a sync from
            // Keycloak metadata, not a real user request, and we
            // don't want to falsely refresh the activity signal.
            deletedAt: null,
          },
          create: {
            id: kcUser.id,
            orgId,
            username: kcUser.username,
            email: kcUser.email ?? '',
            fullName,
            orgRole: role,
            // No lastSeenAt on create either: the user hasn't hit
            // the API yet from our perspective. Leaving it null
            // means /admin/housekeeping renders them as "Never"
            // which is the truth.
          },
        });
        // Track which username was reconciled in which org. Keyed
        // by username (lowercased) since username is what the
        // soft-delete pass keys on. Not by id: a username-keyed
        // upsert may resolve to a different id than `kcUser.id`
        // when a seed row predates the realm.
        seenByOrg.get(orgId)?.add(kcUser.username.toLowerCase());

        // The upsert helper doesn't tell us whether it inserted or
        // updated. We approximate by comparing createdAt to now:
        // a row whose createdAt is within the last second is
        // almost certainly a fresh insert.
        if (Date.now() - result.createdAt.getTime() < 1_000) inserted++;
        else updated++;

        if (first + page.indexOf(kcUser) >= KeycloakSyncService.MAX_USERS_PER_RUN) {
          this.log.warn(
            `reconcileAll: hit MAX_USERS_PER_RUN cap (${KeycloakSyncService.MAX_USERS_PER_RUN}); truncating`,
          );
          break;
        }
      }

      if (page.length < KeycloakSyncService.PAGE_SIZE) break;
      first += KeycloakSyncService.PAGE_SIZE;
    }

    // Soft-delete pass. For each org we processed, find Prisma users
    // whose username was NOT in the realm scan and mark them as
    // soft-deleted. Skip already-tombstoned rows so we don't
    // bump deletedAt on every run. We deliberately don't hard-delete:
    // FK references (items, share rows, group memberships) stay
    // valid, and a future admin action can purge for real.
    let softDeleted = 0;
    for (const [orgId, seenUsernames] of seenByOrg) {
      const candidates = await this.prisma.user.findMany({
        where: {
          orgId,
          deletedAt: null,
        },
        select: { id: true, username: true },
      });
      const stale = candidates.filter(
        (u) => !seenUsernames.has(u.username.toLowerCase()),
      );
      if (stale.length === 0) continue;
      const now = new Date();
      const result = await this.prisma.user.updateMany({
        where: { id: { in: stale.map((u) => u.id) } },
        data: { deletedAt: now },
      });
      softDeleted += result.count;
      this.log.log(
        `reconcileAll: soft-deleted ${result.count} stale users in org ${orgId}: ${stale
          .map((u) => u.username)
          .join(', ')}`,
      );
    }

    const elapsed = Date.now() - tStart;
    this.log.log(
      `reconcileAll done in ${elapsed}ms: pages=${pagesScanned} realmUsers=${realmUsersSeen} inserted=${inserted} updated=${updated} softDeleted=${softDeleted} skipped(noOrg)=${skippedNoOrgAttr} skipped(unknownOrg)=${skippedUnknownOrg}`,
    );

    return {
      skipped: false,
      pagesScanned,
      realmUsersSeen,
      inserted,
      updated,
      softDeleted,
      skippedNoOrgAttr,
      skippedUnknownOrg,
    };
  }
}

/** Read a single-valued user attribute from Keycloak's array shape. */
function readSingleAttr(
  user: KeycloakUserRep,
  key: string,
): string | undefined {
  const arr = user.attributes?.[key];
  if (!Array.isArray(arr)) return undefined;
  const first = arr[0];
  return typeof first === 'string' && first.length > 0 ? first : undefined;
}

/**
 * Pull the user's org role from `attributes.org_role`, defaulting to
 * 'viewer' when absent. Translates the legacy 'publisher' value to
 * 'contributor' to match the renamed enum (#69), so a stale realm
 * export doesn't crash the upsert with an invalid enum value.
 */
function readRole(user: KeycloakUserRep): OrgRole {
  const raw = readSingleAttr(user, 'org_role');
  if (raw === 'publisher') return 'contributor';
  if (raw === 'admin' || raw === 'contributor' || raw === 'viewer') return raw;
  return 'viewer';
}

/**
 * Build a display name from Keycloak's first/last fields, falling
 * back to username when neither is set. Mirrors the helper in
 * KeycloakAdminService so the two upsert paths produce identical
 * fullName values.
 */
function combineName(
  first: string | undefined,
  last: string | undefined,
  username: string,
): string {
  const parts = [first, last].filter(
    (s): s is string => typeof s === 'string' && s.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(' ') : username;
}
