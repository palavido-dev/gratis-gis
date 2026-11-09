// SPDX-License-Identifier: AGPL-3.0-or-later
import { ForbiddenException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { credentialTarget } from './credential-target.js';
import { ItemsService } from './items.service.js';
import { SharingService } from './sharing.service.js';

/**
 * Setting an item's stored credential needs admin, but the place it
 * is sent (`data.url`, or PostGIS Live's host / port / database /
 * role) only needed edit. A partner with an edit share could point
 * the owner's password or token at a server they control and then
 * call the proxy. Changing the target of an item with a stored
 * credential now needs admin too.
 */

const ID = '00000000-0000-4000-8000-0000000000c1';
const T = new Date('2026-11-01T00:00:00.000Z');

function user(id: string): AuthUser {
  return {
    id,
    orgId: 'org-1',
    orgSlug: 'org-1',
    username: id,
    email: `${id}@example.com`,
    orgRole: 'contributor',
    groupIds: [],
    capabilities: new Set(),
  } as unknown as AuthUser;
}

function makeService(opts: { hasCredential: boolean; data: Record<string, unknown> }) {
  const row = {
    id: ID,
    orgId: 'org-1',
    ownerId: 'owner',
    type: 'arcgis_service',
    title: 't',
    tags: [],
    access: 'private',
    data: opts.data,
    deletedAt: null,
    updatedAt: T,
    thumbnailUrl: null,
    thumbnailDesign: null,
    shares: [
      { itemId: ID, principalType: 'user', principalId: 'partner', permission: 'edit', expiresAt: null },
    ],
    owner: null,
  };
  const prisma = {
    item: {
      findUnique: jest.fn(async () => row),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data })),
    },
    itemShare: { findMany: jest.fn(async () => row.shares) },
    itemCredential: {
      findUnique: jest.fn(async () => (opts.hasCredential ? { itemId: ID } : null)),
    },
  };
  const sharing = new SharingService(prisma as never, new PolicyService());
  const svc = new ItemsService(
    prisma as never,
    sharing,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { svc, prisma };
}

const ORIGINAL = { url: 'https://gis.example.org/arcgis/rest/services/x/FeatureServer', requiresAuth: true };
const ATTACKER = { ...ORIGINAL, url: 'https://attacker.example/arcgis/rest/services/x/FeatureServer' };

describe('credentialTarget', () => {
  it('changes with the url and with any PostGIS connection field', () => {
    expect(credentialTarget(ORIGINAL)).not.toBe(credentialTarget(ATTACKER));
    const pg = { protocol: 'postgis_live', host: 'db', port: 5432, database: 'gis', role: 'r' };
    expect(credentialTarget(pg)).toBe(credentialTarget({ ...pg, layers: [] }));
    expect(credentialTarget(pg)).not.toBe(credentialTarget({ ...pg, host: 'evil' }));
    expect(credentialTarget(pg)).not.toBe(credentialTarget({ ...pg, role: 'postgres' }));
    expect(credentialTarget({ title: 'x' })).toBeNull();
  });
});

describe('ItemsService.update credential target', () => {
  it('refuses an editor moving a credentialed item to another url', async () => {
    const { svc, prisma } = makeService({ hasCredential: true, data: ORIGINAL });
    await expect(svc.update(user('partner'), ID, { data: ATTACKER } as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.item.update).not.toHaveBeenCalled();
  });

  it('lets the owner move it', async () => {
    const { svc, prisma } = makeService({ hasCredential: true, data: ORIGINAL });
    await svc.update(user('owner'), ID, { data: ATTACKER } as never);
    expect(prisma.item.update).toHaveBeenCalled();
  });

  it('lets an editor change other fields, or the url of an item with no credential', async () => {
    const same = makeService({ hasCredential: true, data: ORIGINAL });
    await same.svc.update(user('partner'), ID, { data: { ...ORIGINAL, title: 'renamed' } } as never);
    expect(same.prisma.item.update).toHaveBeenCalled();
    const none = makeService({ hasCredential: false, data: ORIGINAL });
    await none.svc.update(user('partner'), ID, { data: ATTACKER } as never);
    expect(none.prisma.item.update).toHaveBeenCalled();
  });
});
