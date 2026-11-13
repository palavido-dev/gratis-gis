// SPDX-License-Identifier: AGPL-3.0-or-later
import { ItemsService } from './items.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { SharingService } from './sharing.service.js';

/**
 * Item reads show the share roster only to people who manage sharing
 * (owner and org admins). The sharing panel's dependency check asks
 * principalAccess instead, which answers yes or no per pair.
 */

const ITEM = '00000000-0000-4000-8000-0000000000f1';
const OTHER_ORG_USER = '00000000-0000-4000-8000-0000000000f9';
const GROUP = '00000000-0000-4000-8000-0000000000a1';

function u(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    orgId: 'org-1',
    orgRole: 'contributor',
    groupIds: [] as string[],
    capabilities: new Set(),
    ...extra,
  };
}

function share(principalType: string, principalId: string, extra: Record<string, unknown> = {}) {
  return {
    itemId: ITEM,
    principalType,
    principalId,
    permission: 'view',
    rowScope: 'all',
    editRowScope: null,
    expiresAt: null,
    geoLimit: null,
    geoBoundaryId: null,
    ...extra,
  };
}

const item = {
  id: ITEM,
  type: 'map',
  orgId: 'org-1',
  ownerId: 'owner',
  access: 'private',
  deletedAt: null,
  data: null,
  shares: [
    share('user', 'viewer'),
    share('group', GROUP),
    share('user', 'expired', { expiresAt: new Date(Date.now() - 1000) }),
  ],
};

function service(principals: Record<string, ReturnType<typeof u>> = {}) {
  const svc = Object.create(ItemsService.prototype) as ItemsService;
  Object.assign(svc, {
    sharing: new SharingService(undefined as never, new PolicyService()),
    authSync: {
      principalForUserId: async (id: string) => principals[id] ?? null,
    },
    prisma: {
      group: {
        findFirst: async ({ where }: { where: { id: string; orgId: string } }) =>
          where.id === GROUP && where.orgId === 'org-1' ? { id: GROUP } : null,
      },
    },
  });
  (svc as unknown as { get: unknown }).get = async (_u: unknown, id: string) => {
    if (id !== ITEM) throw new Error('not found');
    return item;
  };
  return svc;
}

describe('ItemsService.stripShareRoster', () => {
  it('keeps the roster for the owner and an org admin', () => {
    const svc = service();
    for (const caller of [u('owner'), u('boss', { orgRole: 'admin' })]) {
      expect(svc.stripShareRoster(caller as never, item).shares).toHaveLength(3);
    }
  });

  it('empties the roster for a view recipient', () => {
    const svc = service();
    expect(svc.stripShareRoster(u('viewer') as never, item).shares).toEqual([]);
  });

  it('empties the roster on getForReader for a view recipient', async () => {
    const svc = service();
    const row = (await svc.getForReader(u('viewer') as never, ITEM)) as { shares: unknown[] };
    expect(row.shares).toEqual([]);
  });
});

describe('ItemsService.principalAccess', () => {
  it('answers yes or no per pair without returning shares', async () => {
    const svc = service({
      viewer: u('viewer'),
      member: u('member', { groupIds: [GROUP] }),
      nobody: u('nobody'),
      expired: u('expired'),
      [OTHER_ORG_USER]: u(OTHER_ORG_USER, { orgId: 'org-2' }),
    });
    const out = await svc.principalAccess(u('owner') as never, [ITEM, 'missing'], [
      { type: 'user', id: 'viewer' },
      { type: 'user', id: 'member' },
      { type: 'user', id: 'nobody' },
      { type: 'user', id: 'expired' },
      { type: 'user', id: OTHER_ORG_USER },
      { type: 'group', id: GROUP },
      { type: 'group', id: 'unknown-group' },
    ]);
    expect(out).toEqual({
      [ITEM]: {
        'user:viewer': true,
        'user:member': true,
        'user:nobody': false,
        'user:expired': false,
        [`group:${GROUP}`]: true,
      },
    });
  });
});
