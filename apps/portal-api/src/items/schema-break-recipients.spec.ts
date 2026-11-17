// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A field-queue manifest is whatever a device posted, so naming a
// data_collection id in one must not be enough to receive that
// deployment's schema-break notice (titles and layer keys). Only the
// owner and manifest users who can read the deployment get it.

import type { AuthUser } from '../auth/auth-sync.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { SharingService } from './sharing.service.js';
import { ItemsService } from './items.service.js';

const DC = '11111111-1111-4111-8111-111111111111';

function user(id: string, orgId: string): AuthUser {
  return {
    id,
    orgId,
    orgSlug: orgId,
    username: id,
    email: `${id}@example.test`,
    orgRole: 'viewer',
    groupIds: [],
    capabilities: new Set(),
  } as AuthUser;
}

function makeService(withAuthSync: boolean) {
  const item = {
    id: DC,
    orgId: 'org-a',
    ownerId: 'owner',
    type: 'data_collection',
    access: 'private',
    deletedAt: null,
    shares: [{ itemId: DC, principalType: 'user', principalId: 'crew', permission: 'view' }],
  };
  const prisma = {
    item: { findUnique: jest.fn().mockResolvedValue(item) },
  };
  const principals: Record<string, AuthUser> = {
    owner: user('owner', 'org-a'),
    crew: user('crew', 'org-a'),
    colleague: user('colleague', 'org-a'),
    outsider: user('outsider', 'org-b'),
  };
  const authSync = {
    principalForUserId: jest.fn(async (id: string) => principals[id] ?? null),
  };
  const sharing = new SharingService(prisma as never, new PolicyService());
  const service = new ItemsService(
    prisma as never,
    sharing,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    withAuthSync ? (authSync as never) : undefined,
  );
  return service as unknown as {
    schemaBreakRecipients(dc: string, owner: string, reported: string[]): Promise<string[]>;
  };
}

describe('schema-break notice recipients', () => {
  it('keeps the owner and readers, drops users who cannot read the deployment', async () => {
    const service = makeService(true);
    const out = await service.schemaBreakRecipients(DC, 'owner', [
      'crew',
      'outsider',
      'colleague',
      'ghost',
      'crew',
    ]);
    expect(out.sort()).toEqual(['crew', 'owner']);
  });

  it('notifies only the owner when principals cannot be resolved', async () => {
    const service = makeService(false);
    expect(await service.schemaBreakRecipients(DC, 'owner', ['crew', 'outsider'])).toEqual([
      'owner',
    ]);
  });
});
