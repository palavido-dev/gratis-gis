// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AuthUser } from '../auth/auth-sync.service.js';
import { ROLE_BASELINES, type CapabilityKey } from '../auth/capabilities.js';
import type { KeycloakAdminService } from '../admin/keycloak-admin.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { UsersController } from './users.controller.js';

/**
 * `/users/me` is what the web app reads to mirror server gates such as
 * `can_publish_items`. It spreads the AuthUser, whose `capabilities` is
 * a Set, and JSON.stringify turns a Set into `{}`: the web never saw a
 * single capability and fell back to comparing `orgRole`, which ignores
 * every per-user override an admin grants. This pins the wire shape.
 */
function userWithRole(role: 'viewer' | 'contributor' | 'admin'): AuthUser {
  return {
    id: '00000000-0000-0000-0000-0000000000aa',
    orgId: '00000000-0000-0000-0000-0000000000bb',
    orgSlug: 'demo',
    username: 'pat',
    email: 'pat@example.test',
    orgRole: role,
    groupIds: [],
    capabilities: new Set<CapabilityKey>(ROLE_BASELINES[role]),
  };
}

function makeController() {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({
        avatarUrl: null,
        fullName: 'Pat Example',
      }),
    },
    organization: {
      findUnique: jest.fn().mockResolvedValue({ name: 'Demo', slug: 'demo' }),
    },
  } as unknown as PrismaService;
  const kc = {
    isConfigured: jest.fn().mockReturnValue(false),
  } as unknown as KeycloakAdminService;
  return new UsersController(prisma, kc);
}

describe('UsersController.me', () => {
  it('emits capabilities as a sorted array that survives JSON', async () => {
    const out = await makeController().me(userWithRole('contributor'));
    const wire = JSON.parse(JSON.stringify(out)) as {
      capabilities: unknown;
    };
    expect(wire.capabilities).toEqual(
      [...ROLE_BASELINES.contributor].sort(),
    );
    expect(wire.capabilities).toContain('can_publish_items');
  });

  it('reflects a per-user grant, not just the role baseline', async () => {
    // The whole point of shipping the set: an admin grants a viewer
    // `can_publish_items` and the web must see it without the role
    // changing.
    const granted = userWithRole('viewer');
    (granted.capabilities as Set<CapabilityKey>).add('can_publish_items');
    const out = await makeController().me(granted);
    expect(out.orgRole).toBe('viewer');
    expect(out.capabilities).toContain('can_publish_items');
  });

  it('keeps every other field the web already reads', async () => {
    const out = await makeController().me(userWithRole('admin'));
    expect(out).toMatchObject({
      id: '00000000-0000-0000-0000-0000000000aa',
      orgId: '00000000-0000-0000-0000-0000000000bb',
      orgRole: 'admin',
      username: 'pat',
      fullName: 'Pat Example',
      firstName: 'Pat',
      lastName: 'Example',
      avatarUrl: null,
      orgName: 'Demo',
      orgSlug: 'demo',
    });
  });
});
