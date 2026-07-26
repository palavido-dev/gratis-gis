// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { SharingService } from './sharing.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

/**
 * #155 Threaded comments service. Phase 1 ships map-level threads
 * only; the polymorphic anchoring (`parentKind`, `parentId`) is
 * persisted from the start so Phase 2 can attach threads to layer
 * features or drawing features without a schema migration.
 *
 * Permissions:
 *   - LIST / READ: anyone with canRead on the item (anonymous OK
 *     when item is `access='public'`).
 *   - CREATE thread or reply: canRead (anyone who can view can
 *     comment). Phase 1 is signed-in only; anonymous comments land
 *     alongside anonymous markup in Phase 1.5.
 *   - EDIT a comment: the comment's author within an EDIT_WINDOW_MS
 *     grace window, or the item owner / org admin (via canEdit on
 *     the item) at any time.
 *   - DELETE a comment: the author at any time, or the item editor.
 *   - RESOLVE / REOPEN a thread: the thread opener, or the item
 *     editor. Resolved threads are kept (not deleted) so the
 *     conversation history stays auditable.
 *
 * No notification fan-out in Phase 1; the in-portal bell + email
 * paths land in Phase 3 once we have a notifications surface that
 * can carry @-mentions.
 */
const MAX_BODY_LEN = 10_000;
const EDIT_WINDOW_MS = 15 * 60 * 1000;

export interface CommentThreadDTO {
  id: string;
  itemId: string;
  parentKind: 'map' | 'layer' | 'feature' | 'drawing';
  parentId: string;
  resolved: boolean;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  comments: CommentDTO[];
}

export interface CommentDTO {
  id: string;
  threadId: string;
  authorId: string;
  authorDisplay: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
}

@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sharing: SharingService,
  ) {}

  async list(
    user: AuthUser | null,
    itemId: string,
  ): Promise<CommentThreadDTO[]> {
    const item = await this.loadItem(itemId);
    await this.assertCanRead(user, item);
    const threads = await this.prisma.commentThread.findMany({
      where: { itemId },
      orderBy: { createdAt: 'asc' },
      include: {
        comments: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    const authorIds = new Set<string>();
    for (const t of threads) {
      for (const c of t.comments) authorIds.add(c.authorId);
    }
    const authors = await this.prisma.user.findMany({
      where: { id: { in: Array.from(authorIds) } },
      select: { id: true, fullName: true, username: true },
    });
    const displayById = new Map(
      authors.map((a) => [
        a.id,
        a.fullName && a.fullName.trim().length > 0 ? a.fullName : a.username,
      ]),
    );
    return threads.map((t) => this.threadToDto(t, displayById));
  }

  async createThread(
    user: AuthUser,
    itemId: string,
    input: {
      body: string;
      parentKind?: 'map' | 'layer' | 'feature' | 'drawing';
      parentId?: string;
    },
  ): Promise<CommentThreadDTO> {
    const body = this.sanitizeBody(input.body);
    const item = await this.loadItem(itemId);
    await this.assertCanRead(user, item);
    const parentKind = input.parentKind ?? 'map';
    const parentId =
      input.parentId && input.parentId.length > 0
        ? input.parentId.slice(0, 200)
        : itemId;
    const created = await this.prisma.commentThread.create({
      data: {
        itemId,
        parentKind,
        parentId,
        createdBy: user.id,
        comments: {
          create: {
            authorId: user.id,
            body,
          },
        },
      },
      include: { comments: true },
    });
    const display = await this.resolveDisplay(user);
    return this.threadToDto(created, new Map([[user.id, display]]));
  }

  async reply(
    user: AuthUser,
    itemId: string,
    threadId: string,
    input: { body: string },
  ): Promise<CommentDTO> {
    const body = this.sanitizeBody(input.body);
    const item = await this.loadItem(itemId);
    await this.assertCanRead(user, item);
    const thread = await this.prisma.commentThread.findUnique({
      where: { id: threadId },
    });
    if (!thread || thread.itemId !== itemId) {
      throw new NotFoundException('Comment thread not found');
    }
    if (thread.resolved) {
      throw new BadRequestException(
        'Cannot reply to a resolved thread. Reopen it first.',
      );
    }
    const comment = await this.prisma.comment.create({
      data: { threadId, authorId: user.id, body },
    });
    // Touch the thread so list responses keep stable ordering by
    // recency-of-activity when needed; index covers it.
    await this.prisma.commentThread.update({
      where: { id: threadId },
      data: { updatedAt: new Date() },
    });
    const display = await this.resolveDisplay(user);
    return this.commentToDto(comment, display);
  }

  async editComment(
    user: AuthUser,
    itemId: string,
    threadId: string,
    commentId: string,
    input: { body: string },
  ): Promise<CommentDTO> {
    const body = this.sanitizeBody(input.body);
    const item = await this.loadItem(itemId);
    await this.assertCanRead(user, item);
    // The thread must belong to the item in the path (reply() gets
    // this right). Without the check, read access to ANY item lets
    // a caller address comments on items they cannot see, and the
    // editor override below would be evaluated against the wrong
    // item.
    const thread = await this.prisma.commentThread.findUnique({
      where: { id: threadId },
    });
    if (!thread || thread.itemId !== itemId) {
      throw new NotFoundException('Comment thread not found');
    }
    const existing = await this.prisma.comment.findUnique({
      where: { id: commentId },
    });
    if (!existing || existing.threadId !== threadId) {
      throw new NotFoundException('Comment not found');
    }
    const isAuthor = existing.authorId === user.id;
    const withinWindow =
      Date.now() - existing.createdAt.getTime() < EDIT_WINDOW_MS;
    const isEditor = await this.canEditItem(user, item);
    if (!(isAuthor && withinWindow) && !isEditor) {
      throw new ForbiddenException(
        'Comments can only be edited by their author within 15 minutes, ' +
          'or by a map editor at any time',
      );
    }
    const updated = await this.prisma.comment.update({
      where: { id: commentId },
      data: { body, editedAt: new Date() },
    });
    const display = await this.resolveDisplay(user);
    return this.commentToDto(updated, display);
  }

  async deleteComment(
    user: AuthUser,
    itemId: string,
    threadId: string,
    commentId: string,
  ): Promise<void> {
    const item = await this.loadItem(itemId);
    await this.assertCanRead(user, item);
    // Same cross-item guard as editComment. A missing thread stays
    // idempotent (deleting the last comment cascades the thread
    // away, so a retry legitimately finds nothing); a thread that
    // exists under a DIFFERENT item is a cross-item probe and gets
    // a hard NotFound instead.
    const thread = await this.prisma.commentThread.findUnique({
      where: { id: threadId },
    });
    if (!thread) return;
    if (thread.itemId !== itemId) {
      throw new NotFoundException('Comment thread not found');
    }
    const existing = await this.prisma.comment.findUnique({
      where: { id: commentId },
    });
    if (!existing || existing.threadId !== threadId) return; // idempotent
    const isAuthor = existing.authorId === user.id;
    const isEditor = await this.canEditItem(user, item);
    if (!isAuthor && !isEditor) {
      throw new ForbiddenException(
        'Only the comment author or a map editor can delete a comment',
      );
    }
    await this.prisma.comment.delete({ where: { id: commentId } });
    // If the thread now has zero comments, delete it too so the
    // panel doesn't show a ghost thread head with no content.
    const remaining = await this.prisma.comment.count({ where: { threadId } });
    if (remaining === 0) {
      await this.prisma.commentThread.delete({ where: { id: threadId } });
    }
  }

  async setThreadResolved(
    user: AuthUser,
    itemId: string,
    threadId: string,
    resolved: boolean,
  ): Promise<CommentThreadDTO> {
    const item = await this.loadItem(itemId);
    await this.assertCanRead(user, item);
    const thread = await this.prisma.commentThread.findUnique({
      where: { id: threadId },
      include: { comments: { orderBy: { createdAt: 'asc' } } },
    });
    if (!thread || thread.itemId !== itemId) {
      throw new NotFoundException('Comment thread not found');
    }
    const isOpener = thread.createdBy === user.id;
    const isEditor = await this.canEditItem(user, item);
    if (!isOpener && !isEditor) {
      throw new ForbiddenException(
        'Only the thread opener or a map editor can resolve a thread',
      );
    }
    const updated = await this.prisma.commentThread.update({
      where: { id: threadId },
      data: {
        resolved,
        resolvedBy: resolved ? user.id : null,
        resolvedAt: resolved ? new Date() : null,
      },
      include: { comments: { orderBy: { createdAt: 'asc' } } },
    });
    const authors = await this.prisma.user.findMany({
      where: { id: { in: updated.comments.map((c) => c.authorId) } },
      select: { id: true, fullName: true, username: true },
    });
    const displayById = new Map(
      authors.map((a) => [
        a.id,
        a.fullName && a.fullName.trim().length > 0 ? a.fullName : a.username,
      ]),
    );
    return this.threadToDto(updated, displayById);
  }

  // ---- helpers ----------------------------------------------------------

  private sanitizeBody(body: unknown): string {
    if (typeof body !== 'string') {
      throw new BadRequestException('Comment body is required');
    }
    const trimmed = body.trim();
    if (trimmed.length === 0) {
      throw new BadRequestException('Comment body cannot be empty');
    }
    if (trimmed.length > MAX_BODY_LEN) {
      throw new BadRequestException(
        `Comment body is too long (${trimmed.length} of ${MAX_BODY_LEN} max)`,
      );
    }
    return trimmed;
  }

  private async loadItem(itemId: string) {
    const item = await this.prisma.item.findFirst({
      where: { id: itemId, deletedAt: null },
    });
    if (!item) throw new NotFoundException('Item not found');
    return item;
  }

  private async assertCanRead(
    user: AuthUser | null,
    item: Awaited<ReturnType<CommentsService['loadItem']>>,
  ): Promise<void> {
    if (user) {
      const shares = await this.prisma.itemShare.findMany({
        where: { itemId: item.id },
      });
      if (!this.sharing.canRead(user, item, shares)) {
        throw new NotFoundException('Item not found');
      }
    } else if (item.access !== 'public') {
      throw new NotFoundException('Item not found');
    }
  }

  private async canEditItem(
    user: AuthUser,
    item: Awaited<ReturnType<CommentsService['loadItem']>>,
  ): Promise<boolean> {
    const shares = await this.prisma.itemShare.findMany({
      where: { itemId: item.id },
    });
    return this.sharing.canEdit(user, item, shares);
  }

  private async resolveDisplay(user: AuthUser): Promise<string> {
    const row = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { fullName: true, username: true },
    });
    const display =
      (row?.fullName && row.fullName.trim().length > 0 ? row.fullName : null) ??
      row?.username ??
      user.username ??
      'Reviewer';
    return display.slice(0, 200);
  }

  private threadToDto(
    thread: {
      id: string;
      itemId: string;
      parentKind: 'map' | 'layer' | 'feature' | 'drawing';
      parentId: string;
      resolved: boolean;
      resolvedBy: string | null;
      resolvedAt: Date | null;
      createdBy: string;
      createdAt: Date;
      updatedAt: Date;
      comments: {
        id: string;
        threadId: string;
        authorId: string;
        body: string;
        createdAt: Date;
        editedAt: Date | null;
      }[];
    },
    displayById: Map<string, string>,
  ): CommentThreadDTO {
    return {
      id: thread.id,
      itemId: thread.itemId,
      parentKind: thread.parentKind,
      parentId: thread.parentId,
      resolved: thread.resolved,
      resolvedBy: thread.resolvedBy,
      resolvedAt: thread.resolvedAt
        ? thread.resolvedAt.toISOString()
        : null,
      createdBy: thread.createdBy,
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString(),
      comments: thread.comments.map((c) =>
        this.commentToDto(c, displayById.get(c.authorId) ?? 'Reviewer'),
      ),
    };
  }

  private commentToDto(
    c: {
      id: string;
      threadId: string;
      authorId: string;
      body: string;
      createdAt: Date;
      editedAt: Date | null;
    },
    authorDisplay: string,
  ): CommentDTO {
    return {
      id: c.id,
      threadId: c.threadId,
      authorId: c.authorId,
      authorDisplay,
      body: c.body,
      createdAt: c.createdAt.toISOString(),
      editedAt: c.editedAt ? c.editedAt.toISOString() : null,
    };
  }
}
