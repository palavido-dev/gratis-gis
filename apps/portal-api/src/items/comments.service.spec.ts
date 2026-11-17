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
  groupMember: { findMany: jest.Mock };
  commentThread: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
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
    groupMember: { findMany: jest.fn().mockResolvedValue([]) },
    commentThread: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
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

function makeNotifications() {
  return { notify: jest.fn().mockResolvedValue(undefined) };
}

function makeService(
  prisma: FakePrisma,
  notifications: ReturnType<typeof makeNotifications> = makeNotifications(),
): CommentsService {
  const policy = new PolicyService();
  const sharing = new SharingService(prisma as never, policy);
  return new CommentsService(
    prisma as never,
    sharing,
    notifications as never,
  );
}

describe('CommentsService', () => {
  describe('list', () => {
    it('returns empty when the item has no threads', async () => {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(makeItem({ access: 'public' }));
      prisma.commentThread.findMany.mockResolvedValue([]);
      const svc = makeService(prisma);
      await expect(svc.list(null, 'item-1')).resolves.toEqual({
        threads: [],
        nextCursor: null,
      });
    });

    // Review 12-10: the public list returned every thread at once.
    it('returns the newest page oldest first, with a cursor when more exist', async () => {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(makeItem({ access: 'public' }));
      const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n));
      const row = (n: number) => ({
        id: `t${n}`,
        itemId: 'item-1',
        parentKind: 'map',
        parentId: 'item-1',
        resolved: false,
        resolvedBy: null,
        resolvedAt: null,
        createdBy: 'u1',
        createdAt: at(n),
        updatedAt: at(n),
        comments: [],
      });
      // Newest first, one more than the limit.
      prisma.commentThread.findMany.mockResolvedValue([row(5), row(4), row(3)]);
      const svc = makeService(prisma);
      const page = await svc.list(null, 'item-1', { limit: 2 });
      expect(page.threads.map((t) => t.id)).toEqual(['t4', 't5']);
      expect(page.nextCursor).toBe('t4');
      const args = prisma.commentThread.findMany.mock.calls[0][0];
      expect(args.take).toBe(3);
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    });

    it('caps the page at 200 and pages older threads by cursor', async () => {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(makeItem({ access: 'public' }));
      const when = new Date('2026-01-01T00:00:00Z');
      prisma.commentThread.findFirst.mockResolvedValue({ id: 'c1', createdAt: when });
      prisma.commentThread.findMany.mockResolvedValue([]);
      const svc = makeService(prisma);
      await svc.list(null, 'item-1', { limit: 5000, before: 'c1' });
      expect(prisma.commentThread.findFirst.mock.calls[0][0].where).toEqual({
        id: 'c1',
        itemId: 'item-1',
      });
      const args = prisma.commentThread.findMany.mock.calls[0][0];
      expect(args.take).toBe(201);
      expect(args.where).toEqual({
        itemId: 'item-1',
        OR: [
          { createdAt: { lt: when } },
          { createdAt: when, id: { lt: 'c1' } },
        ],
      });
    });

    it('refuses a cursor that is not a thread of this item', async () => {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(makeItem({ access: 'public' }));
      prisma.commentThread.findFirst.mockResolvedValue(null);
      const svc = makeService(prisma);
      await expect(
        svc.list(null, 'item-1', { before: 'other' }),
      ).rejects.toBeInstanceOf(BadRequestException);
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

    it('persists a feature-anchored thread with composite parentId', async () => {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(
        makeItem({ access: 'public', ownerId: 'author-1' }),
      );
      prisma.commentThread.create.mockResolvedValue({
        id: 'thread-2',
        itemId: 'item-1',
        parentKind: 'feature',
        parentId: 'lyr-a:feat-9',
        resolved: false,
        resolvedBy: null,
        resolvedAt: null,
        createdBy: 'author-1',
        createdAt: new Date(),
        updatedAt: new Date(),
        comments: [
          {
            id: 'c-2',
            threadId: 'thread-2',
            authorId: 'author-1',
            body: 'boundary looks wrong',
            createdAt: new Date(),
            editedAt: null,
          },
        ],
      });
      const svc = makeService(prisma);
      const out = await svc.createThread(makeUser(), 'item-1', {
        body: 'boundary looks wrong',
        parentKind: 'feature',
        parentId: 'lyr-a:feat-9',
      });
      expect(out.parentKind).toBe('feature');
      expect(out.parentId).toBe('lyr-a:feat-9');
      const callArg = prisma.commentThread.create.mock.calls[0]![0]!;
      expect(callArg.data.parentKind).toBe('feature');
      expect(callArg.data.parentId).toBe('lyr-a:feat-9');
    });

    it('refuses feature anchors without a composite parentId', async () => {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(
        makeItem({ access: 'public', ownerId: 'author-1' }),
      );
      const svc = makeService(prisma);
      await expect(
        svc.createThread(makeUser(), 'item-1', {
          body: 'oops',
          parentKind: 'feature',
          parentId: 'missing-colon',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('persists a drawing-feature anchor', async () => {
      const prisma = makePrisma();
      prisma.item.findFirst.mockResolvedValue(
        makeItem({ access: 'public', ownerId: 'author-1' }),
      );
      prisma.commentThread.create.mockResolvedValue({
        id: 'thread-3',
        itemId: 'item-1',
        parentKind: 'drawing',
        parentId: '11111111-1111-4111-8111-111111111111',
        resolved: false,
        resolvedBy: null,
        resolvedAt: null,
        createdBy: 'author-1',
        createdAt: new Date(),
        updatedAt: new Date(),
        comments: [
          {
            id: 'c-3',
            threadId: 'thread-3',
            authorId: 'author-1',
            body: 'see this pin',
            createdAt: new Date(),
            editedAt: null,
          },
        ],
      });
      const svc = makeService(prisma);
      const out = await svc.createThread(makeUser(), 'item-1', {
        body: 'see this pin',
        parentKind: 'drawing',
        parentId: '11111111-1111-4111-8111-111111111111',
      });
      expect(out.parentKind).toBe('drawing');
      expect(out.parentId).toBe('11111111-1111-4111-8111-111111111111');
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

    it("keeps the author's name when an item editor edits someone else's comment", async () => {
      const prisma = makePrisma();
      // The caller owns the item, so they may edit any comment on it.
      prisma.item.findFirst.mockResolvedValue(makeItem({ ownerId: 'editor-1' }));
      prisma.commentThread.findUnique.mockResolvedValue({ id: 'thread-1', itemId: 'item-1' });
      prisma.comment.findUnique.mockResolvedValue({
        id: 'c-1',
        threadId: 'thread-1',
        authorId: 'author-1',
        createdAt: new Date(0),
      });
      prisma.comment.update.mockResolvedValue({
        id: 'c-1',
        threadId: 'thread-1',
        authorId: 'author-1',
        body: 'typo fixed',
        createdAt: new Date(0),
        editedAt: new Date(),
      });
      prisma.user.findUnique.mockImplementation(async (a: { where: { id: string } }) =>
        a.where.id === 'author-1'
          ? { fullName: 'Alice Author', username: 'alice' }
          : { fullName: 'Ed Editor', username: 'ed' },
      );
      const out = await makeService(prisma).editComment(
        makeUser({ id: 'editor-1', username: 'ed' }),
        'item-1',
        'thread-1',
        'c-1',
        { body: 'typo fixed' },
      );
      expect(out.authorDisplay).toBe('Alice Author');
    });
  });

  describe('mentions', () => {
    it('notifies an org peer who can read on create', async () => {
      const prisma = makePrisma();
      const notifications = makeNotifications();
      prisma.item.findFirst.mockResolvedValue(
        makeItem({ access: 'org', ownerId: 'author-1' }),
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
            body: 'hey @bob check this',
            createdAt: new Date(),
            editedAt: null,
          },
        ],
      });
      prisma.user.findMany.mockResolvedValue([
        {
          id: 'user-bob',
          username: 'bob',
          email: 'bob@example.com',
          orgId: 'org-1',
          orgRole: 'contributor',
          org: { slug: 'org-1' },
        },
      ]);
      const svc = makeService(prisma, notifications);
      await svc.createThread(makeUser(), 'item-1', {
        body: 'hey @bob check this',
      });
      // notifyMentions is fire-and-forget; flush microtasks
      await new Promise((r) => setImmediate(r));
      expect(notifications.notify).toHaveBeenCalledWith(
        'user-bob',
        'comment_mentioned',
        expect.objectContaining({
          itemId: 'item-1',
          threadId: 'thread-1',
          commentId: 'c-1',
          snippet: expect.stringContaining('@bob'),
        }),
      );
    });

    it('skips self-mentions and unknown handles', async () => {
      const prisma = makePrisma();
      const notifications = makeNotifications();
      prisma.item.findFirst.mockResolvedValue(
        makeItem({ access: 'org', ownerId: 'author-1' }),
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
            body: 'note to @alice and @nobody',
            createdAt: new Date(),
            editedAt: null,
          },
        ],
      });
      prisma.user.findMany.mockResolvedValue([
        {
          id: 'author-1',
          username: 'alice',
          email: 'alice@example.com',
          orgId: 'org-1',
          orgRole: 'contributor',
          org: { slug: 'org-1' },
        },
      ]);
      const svc = makeService(prisma, notifications);
      await svc.createThread(makeUser(), 'item-1', {
        body: 'note to @alice and @nobody',
      });
      await new Promise((r) => setImmediate(r));
      expect(notifications.notify).not.toHaveBeenCalled();
    });
  });
});
