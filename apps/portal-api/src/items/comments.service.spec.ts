// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Item, ItemShare } from '@prisma/client';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { SharingService } from './sharing.service.js';
import { CommentsService } from './comments.service.js';

/**
 * Phase 1 unit tests for the comments service (#155). Exercises
 * the permission chain (anonymous read on public, signed-in
 * create / reply / resolve / delete) and the body sanitizer.
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
    id: 'item-1',
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
  item: { findFirst: jest.Mock };
  itemShare: { findMany: jest.Mock };
  user: { findUnique: jest.Mock; findMany: jest.Mock };
  commentThread: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  comment: {
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    count: jest.Mock;
  };
}

function makePrisma(): FakePrisma {
  return {
    item: { findFirst: jest.fn() },
    itemShare: { findMany: jest.fn().mockResolvedValue([] as ItemShare[]) },
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ fullName: 'Alice Author', username: 'alice' }),
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'author-1', fullName: 'Alice Author', username: 'alice' },
        ]),
    },
    commentThread: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
    },
    comment: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(1),
    },
  };
}

function makeService(prisma: FakePrisma): CommentsService {
  const policy = new PolicyService();
  const sharing = new SharingService(prisma as never, policy);
  return new CommentsService(prisma as never, sharing);
}

describe('CommentsService', () => {
  describe('list', () => {
    it('returns empty when the item has no threads', async () => {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(makeItem({ access: 'public' }));
      prisma.commentThread.findMany.mockResolvedValue([]);
      const svc = makeService(prisma);
      await expect(svc.list(null, 'item-1')).resolves.toEqual([]);
    });

    it('refuses anonymous read on a private item', async () => {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(makeItem({ access: 'private' }));
      const svc = makeService(prisma);
      await expect(svc.list(null, 'item-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('createThread', () => {
    it('rejects an empty body', async () => {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(
        makeItem({ access: 'public', ownerId: 'author-1' }),
      );
      const svc = makeService(prisma);
      await expect(
        svc.createThread(makeUser(), 'item-1', { body: '   ' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a 20kB body', async () => {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(
        makeItem({ access: 'public', ownerId: 'author-1' }),
      );
      const svc = makeService(prisma);
      const huge = 'x'.repeat(20_000);
      await expect(
        svc.createThread(makeUser(), 'item-1', { body: huge }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('persists with default map-level anchoring', async () => {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(
        makeItem({ access: 'public', ownerId: 'author-1' }),
      );
      prisma.commentThread.create.mockResolvedValue({
        id: 'thread-1',
        itemId: 'item-1',
        parentKind: 'map',
        parentId: 'item-1',
        resolved: false,
        resolvedBy: null,
        resolvedAt: null,
        createdBy: 'author-1',
        createdAt: new Date(),
        updatedAt: new Date(),
        comments: [
          {
            id: 'c-1',
            threadId: 'thread-1',
            authorId: 'author-1',
            body: 'hello',
            createdAt: new Date(),
            editedAt: null,
          },
        ],
      });
      const svc = makeService(prisma);
      const out = await svc.createThread(makeUser(), 'item-1', {
        body: 'hello',
      });
      expect(out.parentKind).toBe('map');
      expect(out.parentId).toBe('item-1');
      expect(out.comments.length).toBe(1);
      expect(out.comments[0]!.body).toBe('hello');
      // The persisted data should set parentId from the item when omitted
      const callArg = prisma.commentThread.create.mock.calls[0]![0]!;
      expect(callArg.data.parentKind).toBe('map');
      expect(callArg.data.parentId).toBe('item-1');
    });
  });

  describe('reply', () => {
    it('refuses replies to a resolved thread', async () => {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(
        makeItem({ access: 'public', ownerId: 'author-1' }),
      );
      prisma.commentThread.findUnique.mockResolvedValue({
        id: 'thread-1',
        itemId: 'item-1',
        resolved: true,
      });
      const svc = makeService(prisma);
      await expect(
        svc.reply(makeUser(), 'item-1', 'thread-1', { body: 'hey' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('setThreadResolved', () => {
    it('refuses to resolve a thread the user did not open and cannot edit', async () => {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(
        makeItem({ access: 'public', ownerId: 'someone-else' }),
      );
      prisma.commentThread.findUnique.mockResolvedValue({
        id: 'thread-1',
        itemId: 'item-1',
        createdBy: 'other-user',
        comments: [],
      });
      const svc = makeService(prisma);
      await expect(
        svc.setThreadResolved(makeUser(), 'item-1', 'thread-1', true),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets the opener resolve their own thread even without editor rights', async () => {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(
        makeItem({ access: 'public', ownerId: 'someone-else' }),
      );
      prisma.commentThread.findUnique.mockResolvedValue({
        id: 'thread-1',
        itemId: 'item-1',
        createdBy: 'author-1',
        comments: [],
      });
      prisma.commentThread.update.mockResolvedValue({
        id: 'thread-1',
        itemId: 'item-1',
        parentKind: 'map',
        parentId: 'item-1',
        resolved: true,
        resolvedBy: 'author-1',
        resolvedAt: new Date(),
        createdBy: 'author-1',
        createdAt: new Date(),
        updatedAt: new Date(),
        comments: [],
      });
      const svc = makeService(prisma);
      const out = await svc.setThreadResolved(
        makeUser(),
        'item-1',
        'thread-1',
        true,
      );
      expect(out.resolved).toBe(true);
      expect(out.resolvedBy).toBe('author-1');
    });
  });

  describe('deleteComment', () => {
    it('refuses non-author non-editor delete', async () => {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(
        makeItem({ access: 'public', ownerId: 'someone-else' }),
      );
      prisma.commentThread.findUnique.mockResolvedValue({
        id: 'thread-1',
        itemId: 'item-1',
      });
      prisma.comment.findUnique.mockResolvedValue({
        id: 'c-1',
        threadId: 'thread-1',
        authorId: 'other-user',
      });
      const svc = makeService(prisma);
      await expect(
        svc.deleteComment(makeUser(), 'item-1', 'thread-1', 'c-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cascades thread delete when removing the last comment', async () => {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(
        makeItem({ access: 'public', ownerId: 'author-1' }),
      );
      prisma.commentThread.findUnique.mockResolvedValue({
        id: 'thread-1',
        itemId: 'item-1',
      });
      prisma.comment.findUnique.mockResolvedValue({
        id: 'c-1',
        threadId: 'thread-1',
        authorId: 'author-1',
      });
      prisma.comment.count.mockResolvedValue(0);
      const svc = makeService(prisma);
      await svc.deleteComment(makeUser(), 'item-1', 'thread-1', 'c-1');
      expect(prisma.comment.delete).toHaveBeenCalled();
      expect(prisma.commentThread.delete).toHaveBeenCalledWith({
        where: { id: 'thread-1' },
      });
    });

    it('stays idempotent when the thread is already gone', async () => {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(
        makeItem({ access: 'public', ownerId: 'author-1' }),
      );
      prisma.commentThread.findUnique.mockResolvedValue(null);
      const svc = makeService(prisma);
      await expect(
        svc.deleteComment(makeUser(), 'item-1', 'thread-1', 'c-1'),
      ).resolves.toBeUndefined();
      expect(prisma.comment.delete).not.toHaveBeenCalled();
    });

    it('refuses delete through a thread that belongs to another item', async () => {
      // Regression: the caller has read (and even edit) rights on
      // item-1, but the thread hangs off a different item. Before
      // the thread ownership check, the editor override was
      // evaluated against the wrong item and the delete went
      // through.
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(
        makeItem({ access: 'public', ownerId: 'author-1' }),
      );
      prisma.commentThread.findUnique.mockResolvedValue({
        id: 'thread-1',
        itemId: 'other-item',
      });
      prisma.comment.findUnique.mockResolvedValue({
        id: 'c-1',
        threadId: 'thread-1',
        authorId: 'other-user',
      });
      const svc = makeService(prisma);
      await expect(
        svc.deleteComment(makeUser(), 'item-1', 'thread-1', 'c-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.comment.delete).not.toHaveBeenCalled();
    });
  });

  describe('editComment', () => {
    it('refuses edit through a thread that belongs to another item', async () => {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(
        makeItem({ access: 'public', ownerId: 'author-1' }),
      );
      prisma.commentThread.findUnique.mockResolvedValue({
        id: 'thread-1',
        itemId: 'other-item',
      });
      prisma.comment.findUnique.mockResolvedValue({
        id: 'c-1',
        threadId: 'thread-1',
        authorId: 'other-user',
        createdAt: new Date(),
      });
      const svc = makeService(prisma);
      await expect(
        svc.editComment(makeUser(), 'item-1', 'thread-1', 'c-1', {
          body: 'overwritten',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.comment.update).not.toHaveBeenCalled();
    });

    it('lets the author edit within the window when the thread matches', async () => {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(
        makeItem({ access: 'public', ownerId: 'someone-else' }),
      );
      prisma.commentThread.findUnique.mockResolvedValue({
        id: 'thread-1',
        itemId: 'item-1',
      });
      prisma.comment.findUnique.mockResolvedValue({
        id: 'c-1',
        threadId: 'thread-1',
        authorId: 'author-1',
        createdAt: new Date(),
      });
      prisma.comment.update.mockResolvedValue({
        id: 'c-1',
        threadId: 'thread-1',
        authorId: 'author-1',
        body: 'fixed',
        createdAt: new Date(),
        editedAt: new Date(),
      });
      const svc = makeService(prisma);
      const out = await svc.editComment(
        makeUser(),
        'item-1',
        'thread-1',
        'c-1',
        { body: 'fixed' },
      );
      expect(out.body).toBe('fixed');
    });
  });
});
