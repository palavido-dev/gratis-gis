// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Item, ItemShare } from '@prisma/client';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { SharingService } from './sharing.service.js';
import {
  DRAWING_LIMITS,
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
  $queryRaw: jest.Mock;
  $transaction: jest.Mock;
}

function makePrisma(): FakePrisma {
  const prisma: FakePrisma = {
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
    // The row lock reads the same row findFirst serves, unless a test
    // overrides it to simulate a write that landed in between.
    $queryRaw: jest.fn(async () => {
      const item = (await prisma.item.findFirst()) as Item | null;
      return item ? [{ data: item.data, updated_at_ms: 0 }] : [];
    }),
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  return prisma;
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

  describe('writes under the row lock', () => {
    it('applies a create to the data read under the lock, not the earlier read', async () => {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(
        makeItem({ ownerId: 'author-1', access: 'public', data: { drawings: [] } as never }),
      );
      // Another reviewer's set (and a map Save's layers) landed after
      // the permission read.
      prisma.$queryRaw.mockResolvedValue([
        {
          data: {
            layers: [{ id: 'saved-layer' }],
            drawings: [{ id: 'other-set', authorId: 'u2', color: '#ff0000', features: [] }],
          },
          updated_at_ms: 0,
        },
      ]);
      prisma.item.update.mockResolvedValue(makeItem());
      const svc = makeService(prisma);
      await svc.create({ kind: 'user', user: makeUser() }, 'map-1', {});
      const written = (prisma.item.update.mock.calls[0]![0] as {
        data: { data: { layers: unknown[]; drawings: Array<{ id: string }> } };
      }).data.data;
      expect(written.layers).toEqual([{ id: 'saved-layer' }]);
      expect(written.drawings.map((d) => d.id)).toContain('other-set');
      expect(written.drawings).toHaveLength(2);
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('keeps a concurrent edit to another set when updating one', async () => {
      const prisma = makePrisma();
      const mine = { id: 'mine', authorId: 'author-1', color: '#00ff00', title: 'Mine', features: [] };
      prisma.item.findFirst.mockResolvedValue(
        makeItem({ access: 'public', data: { drawings: [mine] } as never }),
      );
      prisma.$queryRaw.mockResolvedValue([
        {
          data: {
            drawings: [mine, { id: 'theirs', authorId: 'u2', color: '#ff0000', features: [] }],
          },
          updated_at_ms: 0,
        },
      ]);
      prisma.item.update.mockResolvedValue(makeItem());
      const svc = makeService(prisma);
      await svc.update({ kind: 'user', user: makeUser() }, 'map-1', 'mine', { title: 'Renamed' });
      const written = (prisma.item.update.mock.calls[0]![0] as {
        data: { data: { drawings: Array<{ id: string; title?: string }> } };
      }).data.data;
      expect(written.drawings.map((d) => d.id)).toEqual(['mine', 'theirs']);
      expect(written.drawings[0]!.title).toBe('Renamed');
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

  // Any reader of a public map can add markup, and the nested DTO
  // limits never run, so the service must bound what it stores.
  describe('feature validation', () => {
    async function createWith(features: unknown[]) {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(
        makeItem({ ownerId: 'author-1', access: 'public' }),
      );
      prisma.item.update.mockResolvedValue(makeItem());
      const svc = makeService(prisma);
      const author: DrawingsAuthor = { kind: 'user', user: makeUser() };
      return svc.create(author, 'map-1', { features: features as never });
    }

    it('keeps only type and coordinates, and mints a short id and a real date', async () => {
      const set = await createWith([
        {
          id: 'x'.repeat(1000),
          kind: 'line',
          geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]], junk: 'y' },
          style: { dashStyle: 'z'.repeat(500) },
          createdAt: 'not a date',
        },
      ]);
      const f = set.features[0]!;
      expect(f.geometry).toEqual({ type: 'LineString', coordinates: [[0, 0], [1, 1]] });
      expect(f.id.length).toBeLessThanOrEqual(64);
      expect(Number.isNaN(Date.parse(f.createdAt))).toBe(false);
      expect(f.style?.dashStyle).toBeUndefined();
    });

    it('drops malformed coordinates and features over the vertex cap', async () => {
      const big = Array.from(
        { length: DRAWING_LIMITS.MAX_VERTICES_PER_FEATURE + 1 },
        (_, i) => [i % 180, 0],
      );
      const set = await createWith([
        { kind: 'pin', geometry: { type: 'Point', coordinates: ['a', 0] } },
        { kind: 'line', geometry: { type: 'LineString', coordinates: [0, 0] } },
        { kind: 'line', geometry: { type: 'LineString', coordinates: big } },
        { kind: 'pin', geometry: { type: 'Point', coordinates: [1, 2] } },
      ]);
      expect(set.features.map((f) => f.geometry)).toEqual([
        { type: 'Point', coordinates: [1, 2] },
      ]);
    });

    it('refuses a set larger than the byte cap', async () => {
      const line = Array.from({ length: 9000 }, (_, i) => [i / 7, i / 3]);
      const features = Array.from({ length: 10 }, () => ({
        kind: 'line',
        geometry: { type: 'LineString', coordinates: line },
      }));
      await expect(createWith(features)).rejects.toBeInstanceOf(
        BadRequestException,
      );
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
