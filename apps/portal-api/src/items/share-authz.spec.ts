// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, ForbiddenException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { ROLE_BASELINES, type CapabilityKey } from '../auth/capabilities.js';
import { ItemsService } from './items.service.js';

/**
 * Sharing gates: can_share_items is the switch an admin flips to stop
 * a user publishing data, so it must hold on share() and on widening
 * access. Share targets and new owners must be live users and groups
 * of the item's own organization.
 */
const ORG = 'org-a';

function user(
  role: 'viewer' | 'contributor' | 'admin',
  revoke: CapabilityKey[] = [],
): AuthUser {
  const caps = new Set<CapabilityKey>(ROLE_BASELINES[role]);
  for (const c of revoke) caps.delete(c);
  return {
    id: 'owner-1',
    orgId: ORG,
    orgRole: role,
    groupIds: [],
    capabilities: caps,
  } as unknown as AuthUser;
}

function service(opts: {
  users?: Array<{ id: string; orgId: string; deletedAt: Date | null; orgRole?: string }>;
  groups?: Array<{ id: string; orgId: string; deletedAt: Date | null }>;
  canAdmin?: boolean;
}) {
  const svc = Object.create(ItemsService.prototype) as ItemsService;
  const item = { id: 'item-1', orgId: ORG, ownerId: 'owner-1', access: 'private', shares: [] };
  const users = opts.users ?? [];
  const groups = opts.groups ?? [];
  const match = <T extends { id: string; orgId: string; deletedAt: Date | null }>(
    rows: T[],
    where: { id: string; orgId?: string; deletedAt?: null },
  ) =>
    rows.find(
      (r) =>
        r.id === where.id &&
        (where.orgId === undefined || r.orgId === where.orgId) &&
        (!('deletedAt' in where) || r.deletedAt === null),
    ) ?? null;
  const upsert = jest.fn(async () => ({}));
  Object.assign(svc, {
    get: jest.fn(async () => item),
    sharing: { canAdmin: () => opts.canAdmin ?? true, canEdit: () => true },
    prisma: {
      itemShare: {
        upsert,
        findMany: jest.fn(async () => []),
        findUnique: jest.fn(async () => ({ itemId: 'item-1' })),
      },
      user: {
        findFirst: jest.fn(async ({ where }: { where: { id: string; orgId?: string } }) =>
          match(users, where),
        ),
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
          const u = users.find((x) => x.id === where.id);
          return u ? { ...u, capabilityOverrides: [] } : null;
        }),
      },
      group: {
        findFirst: jest.fn(async ({ where }: { where: { id: string; orgId?: string } }) =>
          match(groups, where),
        ),
      },
    },
  });
  return { svc, upsert };
}

describe('ItemsService sharing gates', () => {
  it('refuses share() without can_share_items', async () => {
    const { svc, upsert } = service({});
    await expect(
      svc.share(user('contributor', ['can_share_items']), 'item-1', {
        principalType: 'user',
        principalId: 'u-2',
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses widening access without can_share_items', async () => {
    const { svc } = service({});
    await expect(
      svc.update(user('contributor', ['can_share_items']), 'item-1', {
        access: 'public',
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // An edit share must not let its holder change who can see the item
  // or lift a tier's geographic limit: share() needs owner or admin.
  it('refuses an access change from an editor who is not owner or admin', async () => {
    const { svc } = service({ canAdmin: false });
    await expect(
      svc.update(user('contributor'), 'item-1', { access: 'public' } as never),
    ).rejects.toThrow('Only the owner or an org admin');
  });

  it('refuses a tier boundary change from an editor who is not owner or admin', async () => {
    const { svc } = service({ canAdmin: false });
    await expect(
      svc.update(user('contributor'), 'item-1', {
        publicGeoBoundaryId: null,
        orgGeoBoundaryId: '00000000-0000-0000-0000-000000000001',
      } as never),
    ).rejects.toThrow('Only the owner or an org admin');
  });

  it('keeps the stored permission when an update omits it', async () => {
    const { svc, upsert } = service({
      users: [{ id: 'u-2', orgId: ORG, deletedAt: null, orgRole: 'contributor' }],
    });
    await svc
      .share(user('contributor'), 'item-1', {
        principalType: 'user',
        principalId: 'u-2',
        expiresAt: '2030-01-01T00:00:00.000Z',
      } as never)
      .catch(() => undefined);
    const args = (upsert.mock.calls[0] as unknown as [
      { update: Record<string, unknown>; create: Record<string, unknown> },
    ])[0];
    expect(args.update).not.toHaveProperty('permission');
    expect(args.create.permission).toBe('view');
  });

  it('refuses a user principal from another org', async () => {
    const { svc } = service({ users: [{ id: 'u-b', orgId: 'org-b', deletedAt: null }] });
    await expect(
      svc.share(user('contributor'), 'item-1', {
        principalType: 'user',
        principalId: 'u-b',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a removed user principal', async () => {
    const { svc } = service({ users: [{ id: 'u-x', orgId: ORG, deletedAt: new Date() }] });
    await expect(
      svc.share(user('contributor'), 'item-1', {
        principalType: 'user',
        principalId: 'u-x',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a group principal from another org', async () => {
    const { svc } = service({ groups: [{ id: 'g-b', orgId: 'org-b', deletedAt: null }] });
    await expect(
      svc.share(user('contributor'), 'item-1', {
        principalType: 'group',
        principalId: 'g-b',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to hand ownership to a removed user or a viewer', async () => {
    const { svc } = service({
      users: [
        { id: 'gone', orgId: ORG, deletedAt: new Date(), orgRole: 'contributor' },
        { id: 'view', orgId: ORG, deletedAt: null, orgRole: 'viewer' },
      ],
    });
    await expect(
      svc.reassignOwner(user('admin'), 'item-1', { newOwnerId: 'gone' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.reassignOwner(user('admin'), 'item-1', { newOwnerId: 'view' }),
    ).rejects.toThrow(/contributor or admin/);
  });
});
