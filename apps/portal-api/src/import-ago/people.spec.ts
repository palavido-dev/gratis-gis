// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadGatewayException, ConflictException } from '@nestjs/common';

import { AccountExistsException } from '../admin/keycloak-admin.service';

import type { AuthUser } from '../auth/auth-sync.service';

import type { AgoClient } from './ago-client';
import { resetTenancyModeForTests } from '../common/tenancy';

import { ADDRESS_UNAVAILABLE, agoRoleToPortal, AgoPeopleImportService, portalUsername } from './people';

const admin = {
  id: 'me',
  orgId: 'org-1',
  orgSlug: 'acme',
  orgRole: 'admin',
} as unknown as AuthUser;

function setup(
  opts: {
    existingUsernames?: string[];
    takenEmails?: string[];
    existingGroups?: string[];
    /** What createUser throws for a taken email. */
    takenError?: () => Error;
    /** Organization slug of each existing account, by username or email. */
    accountOrg?: Record<string, string>;
    /** Usernames with a local row in the caller's organization. */
    localInOrg?: string[];
  } = {},
) {
  const created: Array<Record<string, unknown>> = [];
  const localUsers = [{ id: 'me', username: 'me', email: 'me@acme.org' }];
  const kc = {
    isConfigured: () => true,
    findAccountsByUsernameOrEmail: jest.fn(async (u: string, e: string | undefined) =>
      [u, e ?? '']
        .filter((k) => opts.accountOrg?.[k])
        .map((k) => ({ id: `kc-${k}`, username: k, attributes: { org: [opts.accountOrg![k]!] } })),
    ),
    findUserIdByUsername: jest.fn(async (u: string) =>
      (opts.existingUsernames ?? []).includes(u) ? 'kc-id' : null,
    ),
    createUser: jest.fn(async (input: Record<string, unknown>) => {
      if ((opts.takenEmails ?? []).includes(input.email as string)) {
        throw opts.takenError
          ? opts.takenError()
          : new ConflictException('A user with that username or email already exists.');
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
    user: {
      findMany: jest.fn(async () => localUsers),
      findFirst: jest.fn(async (args: { where: { OR: Array<{ username?: { equals: string } }> } }) => {
        const name = args.where.OR[0]?.username?.equals;
        return name && (opts.localInOrg ?? []).includes(name) ? { id: `u-${name}` } : null;
      }),
    },
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
  return { svc, client, created, groupsCreated, members, kc, prisma };
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

  it.each([
    ['the account exists answer', () => new AccountExistsException()],
    ['a 409 in other words', () => new ConflictException('Could not invite this address.')],
  ])('counts a person as matched from %s, by status not text', async (_label, takenError) => {
    const t = setup({ takenEmails: ['pat@acme.org'], takenError });
    const { report } = await t.svc.run({
      user: admin,
      client: t.client,
      options: { import: true, sendSetupEmail: true },
    });
    expect(report.usersMatched).toBe(1);
    expect(report.usersCreated).toBe(2);
  });

  it('does not count another failure as matched because of its words', async () => {
    const t = setup({
      takenEmails: ['pat@acme.org'],
      takenError: () => new BadGatewayException('Upstream says: user already exists'),
    });
    const { report } = await t.svc.run({
      user: admin,
      client: t.client,
      options: { import: true, sendSetupEmail: true },
    });
    expect(report.usersMatched).toBe(0);
    expect(report.usersFailed).toBe(2);
  });
});

describe('people already holding an account, by organization mode', () => {
  const before = process.env.GRATIS_TENANCY;
  afterEach(() => {
    if (before === undefined) delete process.env.GRATIS_TENANCY;
    else process.env.GRATIS_TENANCY = before;
    resetTenancyModeForTests();
  });
  function mode(m: 'single' | 'multi'): void {
    if (m === 'multi') process.env.GRATIS_TENANCY = 'multi';
    else delete process.env.GRATIS_TENANCY;
    resetTenancyModeForTests();
  }
  // jane's username and pat's email have accounts in another organization.
  const elsewhere = {
    existingUsernames: ['jane_acme'],
    takenEmails: ['pat@acme.org'],
    accountOrg: { jane_acme: 'other-org', 'pat@acme.org': 'other-org' },
  };
  const run = (t: ReturnType<typeof setup>) =>
    t.svc.run({ user: admin, client: t.client, options: { import: true, sendSetupEmail: true } });

  it('one organization: such people are matched exactly as before, with no lookup', async () => {
    mode('single');
    const t = setup(elsewhere);
    const { report } = await run(t);
    expect(report.usersMatched).toBe(2);
    expect(report.usersCreated).toBe(1);
    expect(report).not.toHaveProperty('usersSkipped');
    expect(t.kc.findAccountsByUsernameOrEmail).not.toHaveBeenCalled();
    expect(t.prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('many organizations: an account outside the organization is skipped, not matched or mapped', async () => {
    mode('multi');
    const t = setup(elsewhere);
    const { report } = await run(t);
    expect(report.usersMatched).toBe(0);
    expect(report.usersSkipped).toBe(2);
    expect(report.usersCreated).toBe(1);
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        `User Jane_Acme was skipped: ${ADDRESS_UNAVAILABLE}`,
        `User pat_acme was skipped: ${ADDRESS_UNAVAILABLE}`,
      ]),
    );
    // Only the person created here joins the group; the skipped people
    // are never mapped to the existing accounts.
    expect(t.members).toEqual([['g-1', 'u-bob_acme', 'member']]);
    const text = JSON.stringify(report);
    expect(text).not.toContain('other-org');
    expect(text).not.toContain('kc-');
  });

  it.each([
    ['its Keycloak account names the organization', { accountOrg: { jane_acme: 'acme', 'pat@acme.org': 'acme' } }],
    ['its Keycloak account holds the organization id', { accountOrg: { jane_acme: 'org-1', 'pat@acme.org': 'org-1' } }],
    ['it has a local row in the organization', { localInOrg: ['jane_acme', 'pat_acme'] }],
  ])('many organizations: an account in the organization is matched when %s', async (_l, extra) => {
    mode('multi');
    const t = setup({ existingUsernames: ['jane_acme'], takenEmails: ['pat@acme.org'], ...extra });
    const { report } = await run(t);
    expect(report.usersMatched).toBe(2);
    expect(report.usersSkipped).toBeUndefined();
  });

  it('many organizations: a failed lookup counts as not created, not as matched', async () => {
    mode('multi');
    const t = setup({ takenEmails: ['pat@acme.org'] });
    t.kc.findAccountsByUsernameOrEmail.mockImplementation(async () => {
      throw new BadGatewayException('Keycloak user lookup failed: 500');
    });
    const { report } = await run(t);
    expect(report.usersMatched).toBe(0);
    expect(report.usersFailed).toBe(2);
  });
});
