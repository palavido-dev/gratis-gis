// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import { AdminCapabilitiesController } from './admin-capabilities.controller.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { CAPABILITY_KEYS, ENFORCED_CAPABILITY_KEYS } from '../auth/capabilities.js';

/**
 * Only capabilities some route checks may be overridden; the rest
 * would be a switch that does nothing.
 */
function build() {
  const upsert = jest.fn(async () => ({}));
  const prisma = {
    user: {
      findUnique: jest.fn(async () => ({ id: 'u-1', orgId: 'org-1', orgRole: 'contributor' })),
    },
    userCapabilityOverride: { upsert, findMany: jest.fn(async () => []) },
  };
  const kc = { getUser: jest.fn(async () => ({ id: 'kc-1', username: 'ana' })) };
  const ctrl = new AdminCapabilitiesController(
    prisma as never,
    kc as never,
    { invalidate: jest.fn() } as never,
  );
  return { ctrl, upsert };
}

const actor = { id: 'admin', orgId: 'org-1' } as unknown as AuthUser;

describe('AdminCapabilitiesController', () => {
  it('refuses an override on a capability nothing checks', async () => {
    const { ctrl, upsert } = build();
    await expect(
      ctrl.upsert('kc-1', { capability: 'can_manage_users', enabled: true } as never, actor),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('accepts can_share_items and marks rows enforced', async () => {
    const { ctrl, upsert } = build();
    const out = await ctrl.upsert(
      'kc-1',
      { capability: 'can_share_items', enabled: false } as never,
      actor,
    );
    expect(upsert).toHaveBeenCalled();
    const enforced = out.rows.filter((r) => r.enforced).map((r) => r.capability);
    expect(enforced.sort()).toEqual([...ENFORCED_CAPABILITY_KEYS].sort());
    expect(out.rows).toHaveLength(CAPABILITY_KEYS.length);
  });
});
