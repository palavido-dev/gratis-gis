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
import { NotificationsService } from '../notifications/notifications.service.js';
import {
  commentSnippet,
  extractMentionUsernames,
} from './comment-mentions.js';

/**
 * #155 Threaded comments service. Phase 1–2: map / feature / drawing
 * anchors. Phase 3 (R2-comments-mentions): `@username` in create or
 * reply fans out `comment_mentioned` email via NotificationsService
 * (gated by NOTIFICATIONS_ENABLED + prefs). Unknown handles stay
 * literal text. Self-mentions, cross-org users, deleted users, and
 * recipients without canRead are skipped. Cap 10 unique per comment.
 *
 * Permissions:
 *   - LIST / READ: anyone with canRead on the item (anonymous OK
 *     when item is `access='public'`).
 *   - CREATE thread or reply: canRead (anyone who can view can
 *     comment). Signed-in only.
 *   - EDIT a comment: the comment's author within an EDIT_WINDOW_MS
 *     grace window, or the item owner / org admin (via canEdit on
 *     the item) at any time. Edits do not re-fire mention mail.
 *   - DELETE a comment: the author at any time, or the item editor.
 *   - RESOLVE / REOPEN a thread: the thread opener, or the item
 *     editor. Resolved threads are kept (not deleted) so the
 *     conversation history stays auditable.
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
    private readonly notifications: NotificationsService,
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
    const { parentKind, parentId } = normalizeParentRef(
      itemId,
      input.parentKind,
      input.parentId,
    );
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
    const first = created.comments[0];
    if (first) {
      void this.notifyMentions({
        author: user,
        item,
        threadId: created.id,
        commentId: first.id,
        body,
        authorDisplay: display,
      });
    }
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
    void this.notifyMentions({
      author: user,
      item,
      threadId,
      commentId: comment.id,
      body,
      authorDisplay: display,
    });
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
    // The comment is still the author's, also when an editor changed
    // it. Naming the caller showed it as the editor's until a reload.
    const display = isAuthor
      ? await this.resolveDisplay(user)
      : await this.resolveDisplayById(existing.authorId);
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

  /**
   * Resolve `@username` tokens and enqueue mention email. Fire-and-
   * forget: failures must not fail the comment write.
   */
  private async notifyMentions(args: {
    author: AuthUser;
    item: Awaited<ReturnType<CommentsService['loadItem']>>;
    threadId: string;
    commentId: string;
    body: string;
    authorDisplay: string;
  }): Promise<void> {
    try {
      const usernames = extractMentionUsernames(args.body);
      if (usernames.length === 0) return;

      const lowered = usernames.map((u) => u.toLowerCase());
      const candidates = await this.prisma.user.findMany({
        where: {
          orgId: args.author.orgId,
          deletedAt: null,
          OR: lowered.map((u) => ({
            username: { equals: u, mode: 'insensitive' as const },
          })),
        },
        select: {
          id: true,
          username: true,
          email: true,
          orgId: true,
          orgRole: true,
          org: { select: { slug: true } },
        },
      });
      if (candidates.length === 0) return;

      const shares = await this.prisma.itemShare.findMany({
        where: { itemId: args.item.id },
      });
      const memberships = await this.prisma.groupMember.findMany({
        where: { userId: { in: candidates.map((c) => c.id) } },
        select: { userId: true, groupId: true },
      });
      const groupsByUser = new Map<string, string[]>();
      for (const m of memberships) {
        const list = groupsByUser.get(m.userId) ?? [];
        list.push(m.groupId);
        groupsByUser.set(m.userId, list);
      }

      const snippet = commentSnippet(args.body);
      const payloadBase = {
        itemId: args.item.id,
        itemTitle: args.item.title,
        threadId: args.threadId,
        commentId: args.commentId,
        mentionedByName: args.authorDisplay,
        snippet,
      };

      for (const cand of candidates) {
        if (cand.id === args.author.id) continue;
        const recipient: AuthUser = {
          id: cand.id,
          orgId: cand.orgId,
          orgSlug: cand.org.slug,
          username: cand.username,
          email: cand.email,
          orgRole: cand.orgRole,
          groupIds: groupsByUser.get(cand.id) ?? [],
          capabilities: new Set(),
        };
        if (!this.sharing.canRead(recipient, args.item, shares)) continue;
        void this.notifications.notify(
          cand.id,
          'comment_mentioned',
          payloadBase,
        );
      }
    } catch {
      // Mention fan-out must never fail the comment write.
    }
  }

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

  private async resolveDisplayById(userId: string): Promise<string> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { fullName: true, username: true },
    });
    const display =
      (row?.fullName && row.fullName.trim().length > 0 ? row.fullName : null) ??
      row?.username ??
      'Reviewer';
    return display.slice(0, 200);
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

/**
 * Normalize and validate a comment parent ref. Map-level threads
 * default parentId to the item id. Feature anchors must use the
 * `<mapLayerId>:<featureId>` composite so OBJECTIDs do not collide
 * across layers. Drawing anchors are the DrawingFeature UUID.
 * Layer anchors are a MapLayer.id. Empty / missing parentId with a
 * non-map kind is refused rather than silently falling back to the
 * map, so a buggy client cannot create fake map threads.
 */
function normalizeParentRef(
  itemId: string,
  kind: 'map' | 'layer' | 'feature' | 'drawing' | undefined,
  rawId: string | undefined,
): { parentKind: 'map' | 'layer' | 'feature' | 'drawing'; parentId: string } {
  const parentKind = kind ?? 'map';
  const trimmed =
    typeof rawId === 'string' && rawId.trim().length > 0
      ? rawId.trim().slice(0, 200)
      : '';
  if (parentKind === 'map') {
    return { parentKind: 'map', parentId: trimmed.length > 0 ? trimmed : itemId };
  }
  if (trimmed.length === 0) {
    throw new BadRequestException(
      `parentId is required when parentKind is '${parentKind}'`,
    );
  }
  if (parentKind === 'feature') {
    // Composite encoding: mapLayerId:featureId
    const sep = trimmed.indexOf(':');
    if (sep <= 0 || sep === trimmed.length - 1) {
      throw new BadRequestException(
        "parentId for feature comments must be '<mapLayerId>:<featureId>'",
      );
    }
  }
  return { parentKind, parentId: trimmed };
}
