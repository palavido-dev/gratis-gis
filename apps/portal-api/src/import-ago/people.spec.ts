// SPDX-License-Identifier: AGPL-3.0-or-later
import { ConflictException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service';

import type { AgoClient } from './ago-client';
import { agoRoleToPortal, AgoPeopleImportService, portalUsername } from './people';

const admin = {
  id: 'me',
  orgId: 'org-1',
  orgSlug: 'acme',
  orgRole: 'admin',
} as unknown as AuthUser;

function setup(
  opts: { existingUsernames?: string[]; takenEmails?: string[]; existingGroups?: string[] } = {},
) {
  const created: Array<Record<string, unknown>> = [];
  const localUsers = [{ id: 'me', username: 'me', email: 'me@acme.org' }];
  const kc = {
    isConfigured: () => true,
    findUserIdByUsername: jest.fn(async (u: string) =>
      (opts.existingUsernames ?? []).includes(u) ? 'kc-id' : null,
    ),
    createUser: jest.fn(async (input: Record<string, unknown>) => {
      if ((opts.takenEmails ?? []).includes(input.email as string)) {
        throw new ConflictException('A user with that username or email already exists.');
      }
      created.push(input);
      localUsers.push({
        id: `u-${String(input.username)}`,
        username: String(input.username),
        email: String(input.email),
      });
      return { id: `u-${String(input.username)}` };
    }),
  };
  const kcSync = { reconcileAll: jest.fn(async () => ({})) };
  const groupsCreated: Array<Record<string, unknown>> = [];
  const members: Array<[string, string, string]> = [];
  const groups = {
    create: jest.fn(async (_u: AuthUser, input: Record<string, unknown>) => {
      groupsCreated.push(input);
      return { id: `g-${groupsCreated.length}` };
    }),
    addMember: jest.fn(async (_u: AuthUser, g: string, m: string, role: string) => {
      members.push([g, m, role]);
    }),
  };
  const prisma = {
    user: { findMany: jest.fn(async () => localUsers) },
    group: {
      findMany: jest.fn(async () =>
        (opts.existingGroups ?? []).map((t, i) => ({ id: `old-${i}`, title: t })),
      ),
    },
  };
  const client = {
    portalSelf: async () => ({ id: 'agoOrg' }),
    orgUsers: async () => [
      { username: 'Jane_Acme', fullName: 'Jane Q Doe', email: 'jane@acme.org', role: 'org_admin' },
      { username: 'bob_acme', email: 'bob@acme.org', role: 'org_user', roleId: 'iAAAAAAAAAAAAAAA' },
      { username: 'pat_acme', email: 'pat@acme.org', role: 'org_publisher' },
      { username: 'noemail_acme', role: 'org_user' },
    ],
    orgGroups: async () => [
      {
        id: 'G1',
        title: 'Field crew',
        description: '<p>Crews</p>',
        access: 'org',
        owner: 'Jane_Acme',
      },
    ],
    groupUsers: async () => ({
      owner: 'Jane_Acme',
      admins: [],
      users: ['bob_acme', 'pat_acme', 'ghost'],
    }),
  } as unknown as AgoClient;
  const svc = new AgoPeopleImportService(
    kc as never,
    kcSync as never,
    groups as never,
    prisma as never,
  );
  return { svc, client, created, groupsCreated, members, kc };
}

describe('AgoPeopleImportService', () => {
  it('creates users with mapped roles, then groups with their members', async () => {
    const t = setup();
    const { report, maps } = await t.svc.run({
      user: admin,
      client: t.client,
      options: { import: true, sendSetupEmail: false },
    });
    expect(t.created.map((c) => [c.username, c.orgRole, c.firstName, c.lastName, c.org])).toEqual([
      ['jane_acme', 'admin', 'Jane Q', 'Doe', 'acme'],
      ['bob_acme', 'viewer', undefined, undefined, 'acme'],
      ['pat_acme', 'contributor', undefined, undefined, 'acme'],
    ]);
    expect(t.created.every((c) => c.sendSetupEmail === false)).toBe(true);
    expect(report.usersCreated).toBe(3);
    expect(report.usersFailed).toBe(1);
    expect(t.groupsCreated).toEqual([{ title: 'Field crew', description: 'Crews', access: 'org' }]);
    expect(maps.groupIdByAgo.get('G1')).toBe('g-1');
    expect(t.members).toEqual([
      ['g-1', 'u-jane_acme', 'admin'],
      ['g-1', 'u-bob_acme', 'member'],
      ['g-1', 'u-pat_acme', 'member'],
    ]);
    expect(report.memberships).toBe(3);
    expect(report.warnings.some((w) => w.includes('noemail_acme'))).toBe(true);
  });

  it('matches existing users and groups instead of duplicating them', async () => {
    const t = setup({
      existingUsernames: ['jane_acme'],
      takenEmails: ['pat@acme.org'],
      existingGroups: ['field crew'],
    });
    const { report, maps } = await t.svc.run({
      user: admin,
      client: t.client,
      options: { import: true, sendSetupEmail: true },
    });
    expect(report.usersMatched).toBe(2);
    expect(report.usersCreated).toBe(1);
    expect(report.groupsCreated).toBe(0);
    expect(report.groupsMatched).toBe(1);
    expect(maps.groupIdByAgo.get('G1')).toBe('old-0');
  });
});

describe('role and username mapping', () => {
  it('maps ArcGIS roles', () => {
    expect(agoRoleToPortal({ role: 'org_admin' }, false)).toBe('admin');
    expect(agoRoleToPortal({ role: 'org_admin' }, true)).toBe('contributor');
    expect(agoRoleToPortal({ role: 'org_user', roleId: 'iAAAAAAAAAAAAAAA' }, false)).toBe('viewer');
    expect(agoRoleToPortal({ role: 'org_user', roleId: 'iBBBBBBBBBBBBBBB' }, false)).toBe(
      'contributor',
    );
    expect(agoRoleToPortal({ role: 'org_publisher' }, false)).toBe('contributor');
  });
  it('lower-cases usernames', () => {
    expect(portalUsername(' Jane_Acme ')).toBe('jane_acme');
  });
});
