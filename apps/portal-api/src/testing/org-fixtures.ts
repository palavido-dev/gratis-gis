// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Item } from '@prisma/client';

import type { AuthUser } from '../auth/auth-sync.service.js';

/**
 * Shared org-isolation fixtures for Cloud milestone C1.
 *
 * Two distinct orgs so cross-tenant SharingService + visibleWhere
 * checks can prove Org A never gains access to Org B private /
 * org-scoped items (while public items remain intentionally readable).
 */

export const ORG_A = 'org-a';
export const ORG_B = 'org-b';

export function makeAuthUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-a-1',
    orgId: ORG_A,
    orgSlug: ORG_A,
    username: 'alice',
    email: 'alice@example.com',
    orgRole: 'contributor',
    groupIds: [],
    capabilities: new Set(),
    ...overrides,
  } as AuthUser;
}

export function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'item-1',
    orgId: ORG_A,
    ownerId: 'owner-1',
    type: 'data_layer',
    title: 'Parcels',
    description: '',
    tags: [],
    data: {},
    access: 'private',
    bbox: [],
    thumbnailUrl: null,
    license: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastUsageAt: null,
    ...(overrides as Record<string, unknown>),
  } as unknown as Item;
}
