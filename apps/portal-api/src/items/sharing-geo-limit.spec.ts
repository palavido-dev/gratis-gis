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

// A boundary that is trashed, purged or not a geo_boundary must never
// widen access. Before this the share path and the org tier fell back
// to "no clip" and the grantee saw the whole layer.
describe('geoLimitFor missing share and org boundary', () => {
  const empty = {
    item: { findMany: async () => [] },
  } as unknown as PrismaService;
  const square = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
  const withB2 = {
    item: {
      findMany: async () => [{ id: 'b2', data: { geometry: square } }],
    },
  } as unknown as PrismaService;
  const privateItem = { ...item(null), access: 'private' } as Item;
  function share(boundary: string | null, permission = 'read'): ItemShare {
    return {
      principalType: 'user',
      principalId: 'reader',
      permission,
      geoBoundaryId: boundary,
      geoLimit: null,
      expiresAt: null,
    } as unknown as ItemShare;
  }

  it('closes a read share whose boundary is gone', async () => {
    const svc = new SharingService(empty, {} as PolicyService);
    await expect(
      svc.geoLimitFor(user, privateItem, [share('gone')]),
    ).resolves.toBe(CLOSED_GEO_LIMIT);
  });

  it('closes an edit share whose boundary is gone', async () => {
    const svc = new SharingService(empty, {} as PolicyService);
    await expect(
      svc.geoLimitFor(user, privateItem, [share('gone', 'edit')], 'edit'),
    ).resolves.toBe(CLOSED_GEO_LIMIT);
  });

  it('closes the org tier when its boundary is gone', async () => {
    const svc = new SharingService(empty, {} as PolicyService);
    const orgItem = {
      ...privateItem,
      access: 'org',
      orgGeoBoundaryId: 'gone',
    } as Item;
    await expect(svc.geoLimitFor(user, orgItem, [])).resolves.toBe(
      CLOSED_GEO_LIMIT,
    );
  });

  it('keeps the polygon of another share that still resolves', async () => {
    const svc = new SharingService(withB2, {} as PolicyService);
    await expect(
      svc.geoLimitFor(user, privateItem, [share('gone'), share('b2')]),
    ).resolves.toEqual(square);
  });

  it('lets an unclipped path still open the item', async () => {
    const svc = new SharingService(empty, {} as PolicyService);
    await expect(
      svc.geoLimitFor(user, privateItem, [share('gone'), share(null)]),
    ).resolves.toBeNull();
  });
});
