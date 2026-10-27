// SPDX-License-Identifier: AGPL-3.0-or-later
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Item, ItemShare } from '@prisma/client';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { SharingService } from './sharing.service.js';
import {
  DrawingsService,
  type DrawingsAuthor,
} from './drawings.service.js';

/**
 * Phase 1 unit tests for the drawings service (#154). Exercises
 * the permission chain (read / write / author-vs-editor), the
 * server-side sanitizer, and the per-map cap. Heavier integration
 * scenarios (round-trip JSON column on a real Postgres, anon
 * cookie token, rate limit) land alongside Phase 1.5 / 2.
 */

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'author-1',
    orgId: 'org-1',
    orgSlug: 'org-1',
    username: 'alice',
    email: 'alice@example.com',
    orgRole: 'contributor',
    groupIds: [],
    capabilities: new Set(),
    ...overrides,
  } as AuthUser;
}

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'map-1',
    orgId: 'org-1',
    ownerId: 'owner-1',
    type: 'map',
    title: 'Test map',
    description: '',
    tags: [],
    data: {},
    access: 'org',
    bbox: [],
    thumbnailUrl: null,
    thumbnailDesign: null,
    license: null,
    metadata: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    publicGeoBoundaryId: null,
    orgGeoBoundaryId: null,
    ...overrides,
  } as unknown as Item;
}

interface FakePrisma {
  item: {
    findFirst: jest.Mock;
    update: jest.Mock;
  };
  itemShare: {
    findMany: jest.Mock;
  };
  user: {
    findUnique: jest.Mock;
  };
}

function makePrisma(): FakePrisma {
  return {
    item: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    itemShare: {
      findMany: jest.fn().mockResolvedValue([] as ItemShare[]),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({
        fullName: 'Alice Author',
        username: 'alice',
      }),
    },
  };
}

function makeService(prisma: FakePrisma): DrawingsService {
  const policy = new PolicyService();
  const sharing = new SharingService(prisma as never, policy);
  return new DrawingsService(prisma as never, sharing);
}

describe('DrawingsService', () => {
  describe('list', () => {
    it('returns empty when the map has no drawings', async () => {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(makeItem({ access: 'public' }));
      const svc = makeService(prisma);
      await expect(svc.list(null, 'map-1')).resolves.toEqual([]);
    });

    it('throws NotFound on anonymous read of a private map', async () => {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(makeItem({ access: 'private' }));
      const svc = makeService(prisma);
      await expect(svc.list(null, 'map-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('create', () => {
    it('stamps a new set with an auto-assigned color and the user display name', async () => {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(
        makeItem({ ownerId: 'author-1', access: 'public' }),
      );
      prisma.item.update.mockResolvedValue(makeItem());
      const svc = makeService(prisma);
      const author: DrawingsAuthor = { kind: 'user', user: makeUser() };
      const set = await svc.create(author, 'map-1', {});
      expect(set.authorId).toBe('author-1');
      expect(set.authorDisplay).toBe('Alice Author');
      expect(set.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(set.title).toMatch(/^Alice Author's markup \d{4}-\d{2}-\d{2}$/);
      expect(set.features).toEqual([]);
      expect(set.visible).toBe(true);
      expect(prisma.item.update).toHaveBeenCalled();
    });

    it('rejects when the per-map cap is reached', async () => {
      const prisma = makePrisma();
      const sets = Array.from({ length: 64 }, (_, i) => ({
        id: `set-${i}`,
        authorId: 'someone-else',
        authorDisplay: 'Someone',
        title: `Set ${i}`,
        color: '#ef4444',
        visible: true,
        features: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
      prisma.item.findFirst.mockResolvedValue(
        makeItem({
          ownerId: 'author-1',
          access: 'public',
          data: { drawings: sets } as object,
        }),
      );
      const svc = makeService(prisma);
      const author: DrawingsAuthor = { kind: 'user', user: makeUser() };
      await expect(svc.create(author, 'map-1', {})).rejects.toThrow(
        /maximum 64/,
      );
    });

    it('rejects anonymous create when allowAnonymousDrawings is off', async () => {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(
        makeItem({ access: 'public', data: {} }),
      );
      const svc = makeService(prisma);
      const author: DrawingsAuthor = {
        kind: 'anonymous',
        anon: { token: 'tok-1', display: 'Anonymous abcdef' },
      };
      await expect(svc.create(author, 'map-1', {})).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.item.update).not.toHaveBeenCalled();
    });

    it('allows anonymous create when allowAnonymousDrawings is on', async () => {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(
        makeItem({
          access: 'public',
          data: { allowAnonymousDrawings: true } as object,
        }),
      );
      prisma.item.update.mockResolvedValue(makeItem());
      const svc = makeService(prisma);
      const author: DrawingsAuthor = {
        kind: 'anonymous',
        anon: { token: 'tok-anon-1', display: 'Anonymous abcdef' },
      };
      const set = await svc.create(author, 'map-1', {});
      expect(set.authorId).toBeNull();
      expect(set.authorDisplay).toBe('Anonymous abcdef');
      expect(set.anonymousAuthorToken).toBeUndefined();
      // Token is persisted on the item blob but stripped from the
      // public response shape.
      const written = prisma.item.update.mock.calls[0]![0] as {
        data: { data: { drawings: Array<{ anonymousAuthorToken?: string }> } };
      };
      expect(written.data.data.drawings[0]!.anonymousAuthorToken).toBe(
        'tok-anon-1',
      );
    });

    it('drops invalid geometry types from incoming features', async () => {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(
        makeItem({ ownerId: 'author-1', access: 'public' }),
      );
      prisma.item.update.mockResolvedValue(makeItem());
      const svc = makeService(prisma);
      const author: DrawingsAuthor = { kind: 'user', user: makeUser() };
      const set = await svc.create(author, 'map-1', {
        features: [
          {
            id: 'f1',
            kind: 'pin',
            geometry: { type: 'Point', coordinates: [0, 0] },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          {
            // GeometryCollection isn't allowed; the sanitizer drops it.
            id: 'bad',
            kind: 'pin',
            geometry: {
              type: 'GeometryCollection',
              geometries: [],
            } as unknown as never,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      });
      expect(set.features.length).toBe(1);
      expect(set.features[0]!.id).toBe('f1');
    });
  });

  describe('update', () => {
    it('lets the set author rename their own set', async () => {
      const prisma = makePrisma();
      const existing = {
        id: 'set-1',
        authorId: 'author-1',
        authorDisplay: 'Alice Author',
        title: 'Old title',
        color: '#ef4444',
        visible: true,
        features: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      prisma.item.findFirst.mockResolvedValue(
        makeItem({
          ownerId: 'someone-else',
          access: 'public',
          data: { drawings: [existing] } as object,
        }),
      );
      prisma.item.update.mockResolvedValue(makeItem());
      const svc = makeService(prisma);
      const author: DrawingsAuthor = { kind: 'user', user: makeUser() };
      const out = await svc.update(author, 'map-1', 'set-1', {
        title: 'New title',
      });
      expect(out.title).toBe('New title');
    });

    it('refuses a non-author who is also not an editor', async () => {
      const prisma = makePrisma();
      const existing = {
        id: 'set-1',
        authorId: 'someone-else',
        authorDisplay: 'Someone',
        title: 'Theirs',
        color: '#ef4444',
        visible: true,
        features: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      // Public access lets the viewer read; their own user id is
      // not the set author, and they don't own the item, so write
      // should refuse.
      prisma.item.findFirst.mockResolvedValue(
        makeItem({
          ownerId: 'owner-1',
          access: 'public',
          data: { drawings: [existing] } as object,
        }),
      );
      const svc = makeService(prisma);
      const author: DrawingsAuthor = { kind: 'user', user: makeUser() };
      await expect(
        svc.update(author, 'map-1', 'set-1', { title: 'Mine now' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('remove', () => {
    it('idempotently no-ops on a missing set', async () => {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(
        makeItem({ ownerId: 'author-1', access: 'public' }),
      );
      const svc = makeService(prisma);
      const author: DrawingsAuthor = { kind: 'user', user: makeUser() };
      await expect(
        svc.remove(author, 'map-1', 'nonexistent-set'),
      ).resolves.toBeUndefined();
      expect(prisma.item.update).not.toHaveBeenCalled();
    });
  });
});
