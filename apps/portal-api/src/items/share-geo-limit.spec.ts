// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { ROLE_BASELINES, type CapabilityKey } from '../auth/capabilities.js';
import { ItemsService } from './items.service.js';

/**
 * A share's inline clip is passed to ST_GeomFromGeoJSON on every
 * feature read by that sharee. share() refuses a malformed one before
 * anything is written. Bare service, collaborators stubbed: the
 * assertion is only about the gate.
 */
describe('ItemsService.share geoLimit shape', () => {
  const admin = {
    id: '00000000-0000-0000-0000-0000000000aa',
    orgId: '00000000-0000-0000-0000-0000000000bb',
    orgRole: 'admin',
    capabilities: new Set<CapabilityKey>(ROLE_BASELINES.admin),
  } as unknown as AuthUser;

  const REACHED = new Error('reached principal check');

  function service(): ItemsService {
    const svc = Object.create(ItemsService.prototype) as ItemsService;
    Object.assign(svc, {
      get: async () => ({ id: 'i1', orgId: admin.orgId, ownerId: admin.id }),
      sharing: { canAdmin: () => true },
      assertPrincipalExists: async () => {
        throw REACHED;
      },
    });
    return svc;
  }

  const base = { principalType: 'user', principalId: 'u2' } as const;

  it('refuses a polygon with no coordinates', async () => {
    await expect(
      service().share(admin, 'i1', { ...base, geoLimit: { type: 'Polygon' } } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a polygon in projected metres', async () => {
    await expect(
      service().share(admin, 'i1', {
        ...base,
        geoLimit: {
          type: 'Polygon',
          coordinates: [[[500000, 3700000], [500100, 3700000], [500100, 3700100], [500000, 3700000]]],
        },
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lets a closed WGS84 polygon and a null clear through', async () => {
    const square = [[[-118, 34], [-117, 34], [-117, 35], [-118, 35], [-118, 34]]];
    await expect(
      service().share(admin, 'i1', {
        ...base,
        geoLimit: { type: 'Polygon', coordinates: square },
      } as never),
    ).rejects.toBe(REACHED);
    await expect(
      service().share(admin, 'i1', { ...base, geoLimit: null } as never),
    ).rejects.toBe(REACHED);
  });
});
