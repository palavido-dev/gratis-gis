// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AuthUser } from '../auth/auth-sync.service.js';
import { HousekeepingController } from './housekeeping.controller.js';
import type { HousekeepingScheduleService } from './housekeeping-schedule.service.js';
import type { HousekeepingService } from './housekeeping.service.js';
import type { KeycloakAdminService } from './keycloak-admin.service.js';

/**
 * The housekeeping user lists carry the portal's user id, but the
 * page acts on those users through PATCH /admin/users/:id, which
 * takes the Keycloak id. For seeded accounts the two differ, so the
 * rows now carry both.
 */
const me = { id: 'me', orgId: 'org-1' } as AuthUser;

function build(configured: boolean) {
  const rows = [
    { id: 'aaaaaaaa-seeded', username: 'contributor' },
    { id: 'kc-ana', username: 'ana' },
  ];
  const hk = {
    staleUsers: jest.fn(async () => rows),
    expiringUsers: jest.fn(async () => rows),
  };
  const kc = {
    isConfigured: () => configured,
    findUserIdByUsername: jest.fn(async (u: string) => (u === 'contributor' ? 'kc-contributor' : `kc-${u}`)),
  };
  const controller = new HousekeepingController(
    hk as unknown as HousekeepingService,
    {} as HousekeepingScheduleService,
    undefined,
    kc as unknown as KeycloakAdminService,
  );
  return { controller, kc };
}

describe('housekeeping user rows carry the Keycloak id', () => {
  it('resolves it by username for stale and expiring users', async () => {
    const { controller } = build(true);
    for (const rows of [
      await controller.staleUsers(me),
      await controller.expiringUsers(me, undefined),
    ]) {
      expect(rows.map((r) => [r.id, r.keycloakId])).toEqual([
        ['aaaaaaaa-seeded', 'kc-contributor'],
        ['kc-ana', 'kc-ana'],
      ]);
    }
  });

  it('falls back to the portal id when Keycloak is not set up', async () => {
    const { controller, kc } = build(false);
    const rows = await controller.staleUsers(me);
    expect(rows.map((r) => r.keycloakId)).toEqual(['aaaaaaaa-seeded', 'kc-ana']);
    expect(kc.findUserIdByUsername).not.toHaveBeenCalled();
  });
});
