// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ArcGIS Online users and groups into the portal.
 *
 * Runs before the item import when the admin asks for it, so imported
 * items can be shared with the same groups they were in. Read from
 * ArcGIS at run time with the admin's token, never from the
 * client-submitted report.
 *
 * - Users become Keycloak accounts in this organization. A user whose
 *   username or email is already here is matched, not created. Where
 *   accounts are shared by several organizations, an account outside
 *   the caller's organization is skipped with a neutral reason and
 *   never matched.
 * - Roles: Administrator stays Admin, the built-in Viewer role becomes
 *   Viewer, and every other role (User, Publisher, Data Editor, custom)
 *   becomes Contributor. While the admin tier is locked, nobody is made
 *   an Admin.
 * - Groups are created with their title, description and access (or
 *   reused when a group of the same title exists), and get their
 *   members back; the ArcGIS owner and managers become group
 *   admins. The admin running the import also ends up a group admin,
 *   as with any group they create.
 */
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { GroupAccess, OrgRole } from '@prisma/client';

import { isAdminTierLocked } from '../admin/admin-tier-lock.js';
import { KeycloakAdminService } from '../admin/keycloak-admin.service.js';
import { keycloakAccountInOrg } from '../admin/keycloak-org.js';
import { isMultiTenant } from '../common/tenancy.js';
import { KeycloakSyncService } from '../admin/keycloak-sync.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { GroupsService } from '../groups/groups.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

import type { AgoClient } from './ago-client.js';
import type { AgoOrgUser } from './ago-types.js';

export interface PeopleOptions {
  /** Bring users and groups over. */
  import: boolean;
  /** Email each new user a link to set their password. */
  sendSetupEmail: boolean;
}

export interface PeopleReport {
  usersCreated: number;
  usersMatched: number;
  usersFailed: number;
  /**
   * Several organizations only: people whose username or email has an
   * account outside the caller's organization. Absent otherwise.
   */
  usersSkipped?: number;
  groupsCreated: number;
  /** Groups with the same title already here, reused. */
  groupsMatched: number;
  memberships: number;
  /** Item shares added from ArcGIS group sharing. */
  sharesAdded: number;
  warnings: string[];
}

/** What later steps need: ArcGIS group id to portal group id. */
export interface PeopleMaps {
  groupIdByAgo: Map<string, string>;
}

/** The built-in ArcGIS Viewer role. */
const VIEWER_ROLE_ID = 'iAAAAAAAAAAAAAAA';

/** ArcGIS role to portal role. */
export function agoRoleToPortal(
  u: Pick<AgoOrgUser, 'role' | 'roleId'>,
  adminLocked: boolean,
): OrgRole {
  if (u.role === 'org_admin') return adminLocked ? 'contributor' : 'admin';
  if (u.roleId === VIEWER_ROLE_ID) return 'viewer';
  return 'contributor';
}

/** Keycloak usernames are lower case; ArcGIS ones may not be. */
export function portalUsername(agoUsername: string): string {
  return agoUsername.trim().toLowerCase();
}

function groupAccess(access: string | undefined): GroupAccess {
  return access === 'public'
    ? 'public'
    : access === 'org' || access === 'account'
      ? 'org'
      : 'private';
}

function splitName(u: AgoOrgUser): { firstName?: string; lastName?: string } {
  if (u.firstName || u.lastName) {
    return {
      ...(u.firstName ? { firstName: u.firstName } : {}),
      ...(u.lastName ? { lastName: u.lastName } : {}),
    };
  }
  const parts = (u.fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { firstName: parts[0]! };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1]! };
}

@Injectable()
export class AgoPeopleImportService {
  private readonly log = new Logger(AgoPeopleImportService.name);

  constructor(
    private readonly kc: KeycloakAdminService,
    private readonly kcSync: KeycloakSyncService,
    private readonly groups: GroupsService,
    private readonly prisma: PrismaService,
  ) {}

  async run(args: {
    user: AuthUser;
    client: AgoClient;
    options: PeopleOptions;
  }): Promise<{ report: PeopleReport; maps: PeopleMaps }> {
    const report: PeopleReport = {
      usersCreated: 0,
      usersMatched: 0,
      usersFailed: 0,
      groupsCreated: 0,
      groupsMatched: 0,
      memberships: 0,
      sharesAdded: 0,
      warnings: [],
    };
    const maps: PeopleMaps = { groupIdByAgo: new Map() };
    if (!this.kc.isConfigured()) {
      report.warnings.push(
        'Users and groups were not imported: the Keycloak admin client is not configured.',
      );
      return { report, maps };
    }
    const { client, user } = args;

    let agoUsers: AgoOrgUser[];
    let orgId: string | undefined;
    try {
      orgId = (await client.portalSelf()).id;
      agoUsers = await client.orgUsers();
    } catch (e) {
      report.warnings.push(
        `Users and groups were not imported: reading the organization's users needs an ArcGIS administrator (${errorText(e)}).`,
      );
      return { report, maps };
    }

    const adminLocked = isAdminTierLocked();
    let lockedAdmins = 0;
    for (const u of agoUsers) {
      if (!u.username) continue;
      const username = portalUsername(u.username);
      try {
        if (await this.kc.findUserIdByUsername(username)) {
          await this.matchOrSkip(report, user, u.username, username, u.email);
          continue;
        }
        if (!u.email) {
          report.usersFailed += 1;
          report.warnings.push(
            `User ${u.username} has no email address in ArcGIS, so no account was made.`,
          );
          continue;
        }
        const role = agoRoleToPortal(u, adminLocked);
        if (adminLocked && u.role === 'org_admin') lockedAdmins += 1;
        await this.kc.createUser({
          username,
          email: u.email,
          ...splitName(u),
          orgRole: role,
          org: user.orgSlug,
          enabled: u.disabled !== true,
          sendSetupEmail: args.options.sendSetupEmail && u.disabled !== true,
        });
        report.usersCreated += 1;
      } catch (e) {
        // A taken username or email (Keycloak's 409) means the person
        // already has an account. Decided on the status, never the text.
        if (e instanceof HttpException && e.getStatus() === HttpStatus.CONFLICT) {
          try {
            await this.matchOrSkip(report, user, u.username, username, u.email);
          } catch (lookupErr) {
            report.usersFailed += 1;
            report.warnings.push(`User ${u.username} was not created: ${errorText(lookupErr)}`);
          }
          continue;
        }
        report.usersFailed += 1;
        report.warnings.push(`User ${u.username} was not created: ${errorText(e)}`);
      }
    }
    if (lockedAdmins > 0) {
      report.warnings.push(
        `${lockedAdmins} ArcGIS administrator(s) were made Contributors because this portal does not allow new admins.`,
      );
    }
    if (report.usersCreated > 0 && !args.options.sendSetupEmail) {
      report.warnings.push(
        'New users were not emailed. Send each one a password link from Admin, Users, or sign them in through your identity provider.',
      );
    }

    // Local rows for the new accounts, so groups can hold them.
    await this.kcSync.reconcileAll().catch((e: unknown) => {
      report.warnings.push(`Refreshing the user list failed: ${errorText(e)}`);
    });
    const local = await this.prisma.user.findMany({
      where: { orgId: user.orgId },
      select: { id: true, username: true, email: true },
    });
    const byUsername = new Map(local.map((r) => [r.username.toLowerCase(), r.id]));
    const byEmail = new Map(local.map((r) => [r.email.toLowerCase(), r.id]));
    const emailOf = new Map(
      agoUsers
        .filter((u) => u.email)
        .map((u) => [portalUsername(u.username), u.email!.toLowerCase()]),
    );
    const userIdFor = (agoUsername: string): string | undefined => {
      const name = portalUsername(agoUsername);
      const email = emailOf.get(name);
      return byUsername.get(name) ?? (email ? byEmail.get(email) : undefined);
    };

    if (!orgId) {
      report.warnings.push(
        'Groups were not imported: the ArcGIS organization id was not available.',
      );
      return { report, maps };
    }
    let agoGroups;
    try {
      agoGroups = await client.orgGroups(orgId);
    } catch (e) {
      report.warnings.push(`Groups were not imported: ${errorText(e)}`);
      return { report, maps };
    }
    // A second import run reuses the groups the first one made.
    const existing = await this.prisma.group.findMany({
      where: { orgId: user.orgId, deletedAt: null },
      select: { id: true, title: true },
    });
    const groupByTitle = new Map(existing.map((g) => [g.title.toLowerCase(), g.id]));
    for (const g of agoGroups) {
      try {
        const description = (g.description ?? g.snippet ?? '').trim();
        const match = groupByTitle.get(g.title.toLowerCase());
        const created = match
          ? { id: match }
          : await this.groups.create(user, {
              title: g.title,
              ...(description ? { description: stripTags(description).slice(0, 4000) } : {}),
              access: groupAccess(g.access),
            });
        maps.groupIdByAgo.set(g.id, created.id);
        if (match) report.groupsMatched += 1;
        else {
          report.groupsCreated += 1;
          groupByTitle.set(g.title.toLowerCase(), created.id);
        }
        const members = await client
          .groupUsers(g.id)
          .catch(() => ({}) as { owner?: string; admins?: string[]; users?: string[] });
        const managers = new Set([
          ...(members.owner ? [members.owner] : []),
          ...(members.admins ?? []),
        ]);
        for (const name of new Set([...managers, ...(members.users ?? [])])) {
          const id = userIdFor(name);
          if (!id || id === user.id) continue;
          try {
            await this.groups.addMember(
              user,
              created.id,
              id,
              managers.has(name) ? 'admin' : 'member',
            );
            report.memberships += 1;
          } catch (e) {
            report.warnings.push(`Adding ${name} to "${g.title}" failed: ${errorText(e)}`);
          }
        }
      } catch (e) {
        report.warnings.push(`Group "${g.title}" was not created: ${errorText(e)}`);
      }
    }
    this.log.log(
      `People import: ${report.usersCreated} users created, ${report.usersMatched} matched, ${report.groupsCreated} groups`,
    );
    return { report, maps };
  }

  /**
   * A person whose username or email already has an account. With one
   * organization that account is here: matched. With several, it is
   * matched only when it is in the caller's organization; otherwise
   * the person is skipped and the answer does not say where it is.
   */
  private async matchOrSkip(
    report: PeopleReport,
    user: AuthUser,
    agoUsername: string,
    username: string,
    email: string | undefined,
  ): Promise<void> {
    if (!isMultiTenant() || (await this.accountInCallerOrg(user, username, email))) {
      report.usersMatched += 1;
      return;
    }
    report.usersSkipped = (report.usersSkipped ?? 0) + 1;
    report.warnings.push(`User ${agoUsername} was skipped: ${ADDRESS_UNAVAILABLE}`);
  }

  /** Whether an account with this username or email is in the caller's organization. */
  private async accountInCallerOrg(
    user: AuthUser,
    username: string,
    email: string | undefined,
  ): Promise<boolean> {
    const local = await this.prisma.user.findFirst({
      where: {
        orgId: user.orgId,
        OR: [
          { username: { equals: username, mode: 'insensitive' } },
          ...(email ? [{ email: { equals: email, mode: 'insensitive' as const } }] : []),
        ],
      },
      select: { id: true },
    });
    if (local) return true;
    // Created or invited but never signed in: only Keycloak knows them.
    const accounts = await this.kc.findAccountsByUsernameOrEmail(username, email);
    return accounts.some((a) => keycloakAccountInOrg(a, user));
  }
}

/** The reason given for a skipped person; it names no organization. */
export const ADDRESS_UNAVAILABLE =
  'this address cannot be invited. Ask the person to contact support.';

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Group descriptions in ArcGIS are HTML; groups here take plain text. */
function stripTags(s: string): string {
  let out = '';
  let inTag = false;
  for (const ch of s) {
    if (ch === '<') inTag = true;
    else if (ch === '>') inTag = false;
    else if (!inTag) out += ch;
  }
  return out.replace(/\s+\n/g, '\n').trim();
}
