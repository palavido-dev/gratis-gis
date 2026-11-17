// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Item, ItemShare } from '@prisma/client';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { PolicyService } from '../policy/policy.service.js';
import {
  SharingService,
  featureScopeFilter,
  isScopeLimited,
  legacyTableScopeConditions,
} from './sharing.service.js';
import { CLOSED_GEO_LIMIT } from '../common/closed-geo-limit.js';

/**
 * SharingService.featureScopeFor is the one resolver every feature
 * read and write path takes its clip from. These cases pin the write
 * rules: the org and public tiers grant read only, so they never
 * widen an edit, and a view share never loosens an edit share.
 */

const ANY_PRISMA = undefined as unknown as ConstructorParameters<
  typeof SharingService
>[0];

const POLY = {
  type: 'Polygon',
  coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
};

const user = {
  id: 'user-1',
  orgId: 'org-1',
  orgRole: 'contributor',
  groupIds: [],
} as unknown as AuthUser;

function item(access: 'private' | 'org' | 'public'): Item {
  return {
    id: 'item-1',
    orgId: 'org-1',
    ownerId: 'owner-1',
    access,
    orgGeoBoundaryId: null,
    publicGeoBoundaryId: null,
  } as unknown as Item;
}

function share(overrides: Record<string, unknown>): ItemShare {
  return {
    itemId: 'item-1',
    principalType: 'user',
    principalId: 'user-1',
    permission: 'edit',
    rowScope: 'all',
    editRowScope: null,
    expiresAt: null,
    geoLimit: null,
    geoBoundaryId: null,
    ...overrides,
  } as unknown as ItemShare;
}

describe('SharingService.featureScopeFor', () => {
  const svc = new SharingService(ANY_PRISMA, new PolicyService());

  it.each(['org', 'public'] as const)(
    'own-rows-only still binds edits on a %s layer',
    async (access) => {
      const scope = await svc.featureScopeFor(user, item(access), [share({})], {
        action: 'edit',
        layerPolicy: 'own-rows-only',
      });
      expect(scope.rowScope).toBe('own');
    },
  );

  it.each(['org', 'public'] as const)(
    'reads on a %s layer keep the tier bypass',
    async (access) => {
      const scope = await svc.featureScopeFor(user, item(access), [share({ geoLimit: POLY })], {
        action: 'read',
        layerPolicy: 'own-rows-only',
      });
      expect(scope.rowScope).toBe('all');
      expect(scope.geoLimit).toBeNull();
    },
  );

  it('an edit share editRowScope own binds on an org layer', async () => {
    const scope = await svc.featureScopeFor(
      user,
      item('org'),
      [share({ editRowScope: 'own' })],
      { action: 'edit' },
    );
    expect(scope.rowScope).toBe('own');
  });

  it('an edit share geo limit binds on an org layer', async () => {
    const scope = await svc.featureScopeFor(
      user,
      item('org'),
      [share({ geoLimit: POLY })],
      { action: 'edit' },
    );
    expect(scope.geoLimit).toEqual(POLY);
  });

  it('an unclipped view share does not loosen a clipped edit share', async () => {
    const scope = await svc.featureScopeFor(
      user,
      item('private'),
      [
        share({ permission: 'view' }),
        share({ permission: 'edit', geoLimit: POLY, editRowScope: 'own' }),
      ],
      { action: 'edit' },
    );
    expect(scope.geoLimit).toEqual(POLY);
    expect(scope.rowScope).toBe('own');
  });

  it('owners stay unscoped on every action', async () => {
    const owner = { ...user, id: 'owner-1' } as AuthUser;
    const scope = await svc.featureScopeFor(owner, item('org'), [], {
      action: 'edit',
      layerPolicy: 'own-rows-only',
    });
    expect(isScopeLimited(scope)).toBe(false);
    expect(featureScopeFilter(scope)).toEqual({});
  });
});

describe('feature scope helpers', () => {
  it('featureScopeFilter carries both clips for the engine', () => {
    expect(
      featureScopeFilter({ geoLimit: POLY, rowScope: 'own', userId: 'u' }),
    ).toEqual({ geoLimit: POLY, ownRowsOnly: { userId: 'u' } });
  });

  it('legacyTableScopeConditions binds values and closes a missing boundary', () => {
    const params: unknown[] = ['first'];
    const conds = legacyTableScopeConditions(
      { geoLimit: POLY, rowScope: 'own', userId: 'u' },
      params,
    );
    expect(params).toEqual(['first', JSON.stringify(POLY), 'u']);
    expect(conds[0]).toContain('$2::text');
    expect(conds[1]).toBe('created_by = $3::uuid');
    expect(
      legacyTableScopeConditions(
        { geoLimit: CLOSED_GEO_LIMIT, rowScope: 'all', userId: 'u' },
        [],
      ),
    ).toEqual(['false']);
  });
});
