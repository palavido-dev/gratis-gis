// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Item, ItemShare } from '@prisma/client';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { CLOSED_GEO_LIMIT } from '../common/closed-geo-limit.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { PolicyService } from '../policy/policy.service.js';
import { SharingService } from './sharing.service.js';

const user: AuthUser = {
  id: 'reader',
  orgId: 'org-1',
  orgSlug: 'acme',
  username: 'reader',
  email: 'reader@example.com',
  orgRole: 'viewer',
  groupIds: [],
  capabilities: new Set(),
};

function item(boundary: string | null): Item {
  return {
    id: 'item-1',
    ownerId: 'owner',
    orgId: 'org-1',
    access: 'public',
    publicGeoBoundaryId: boundary,
  } as Item;
}

describe('geoLimitFor public boundary', () => {
  it('closes a public item when the boundary row is gone', async () => {
    const prisma = {
      item: { findMany: async () => [] },
    } as unknown as PrismaService;
    const svc = new SharingService(prisma, {} as PolicyService);
    await expect(svc.geoLimitFor(user, item('missing'), [])).resolves.toBe(
      CLOSED_GEO_LIMIT,
    );
  });

  it('does not close the owner, who is warned instead of clipped', async () => {
    const prisma = {
      item: { findMany: async () => [] },
    } as unknown as PrismaService;
    const svc = new SharingService(prisma, {} as PolicyService);
    const owner = { ...user, id: 'owner' };
    await expect(svc.geoLimitFor(owner, item('missing'), [])).resolves.toBeNull();
  });

  it('keeps an explicit share that has no boundary', async () => {
    const prisma = {
      item: { findMany: async () => [] },
    } as unknown as PrismaService;
    const svc = new SharingService(prisma, {} as PolicyService);
    const share = {
      principalType: 'user',
      principalId: 'reader',
      geoBoundaryId: null,
      geoLimit: null,
      expiresAt: null,
    } as ItemShare;
    await expect(svc.geoLimitFor(user, item('missing'), [share])).resolves.toBeNull();
  });
});
