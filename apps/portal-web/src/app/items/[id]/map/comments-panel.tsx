// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Comments panel (#155 Phase 1).
 *
 * A floating overlay on the map editor that lets viewers (not just
 * editors) leave threaded comments on a map. Pairs with the markup
 * panel: a reviewer who drops a redline pin can also leave a
 * threaded conversation about it. Phase 1 ships map-level threads
 * only; Phase 2 will anchor threads to specific features and
 * drawing pins via the polymorphic (parentKind, parentId) the
 * server already persists.
 *
 * Permission posture:
 *   - Any signed-in viewer can read every thread, open new ones,
 *     and reply to existing ones.
 *   - Authors can edit their own comments within a 15-minute
 *     grace window, or any time as a map editor.
 *   - Thread openers can resolve their own threads; map editors
 *     can resolve any thread.
 *   - Resolved threads hide by default behind a "show resolved"
 *     toggle so the conversation stays auditable.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  Loader2,
  MessageSquarePlus,
  Send,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';

interface CommentDTO {
  id: string;
  threadId: string;
  authorId: string;
  authorDisplay: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
}

interface ThreadDTO {
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

interface Props {
  itemId: string;
  open: boolean;
  onClose: () => void;
  currentUser: { id: string; displayName: string } | null;
  /** True when the viewer can edit the parent map item. Editors
   *  see resolve / delete actions on every thread; viewers see
   *  them only for their own. */
  canEditItem: boolean;
}

export function CommentsPanel({
  itemId,
  open,
  onClose,
  currentUser,
  canEditItem,
}: Props) {
  const [threads, setThreads] = useState<ThreadDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [draftBody, setDraftBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fresh = await api<ThreadDTO[]>(`/api/portal/items/${itemId}/comments`);
      setThreads(fresh);
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, [itemId]);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const visibleThreads = useMemo(() => {
    if (showResolved) return threads;
    return threads.filter((t) => !t.resolved);
  }, [threads, showResolved]);

  const startThread = useCallback(async () => {
    if (!currentUser) return;
    const body = draftBody.trim();
    if (body.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api<ThreadDTO>(
        `/api/portal/items/${itemId}/comments`,
        { method: 'POST', body: JSON.stringify({ body }) },
      );
      setThreads((curr) => [...curr, created]);
      setDraftBody('');
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }, [currentUser, draftBody, itemId]);

  const sendReply = useCallback(
    async (threadId: string) => {
      const body = (replyDrafts[threadId] ?? '').trim();
      if (body.length === 0) return;
      setBusy(true);
      setError(null);
      try {
        const reply = await api<CommentDTO>(
          `/api/portal/items/${itemId}/comments/${threadId}/replies`,
          { method: 'POST', body: JSON.stringify({ body }) },
        );
        setThreads((curr) =>
          curr.map((t) =>
            t.id === threadId
              ? { ...t, comments: [...t.comments, reply] }
              : t,
          ),
        );
        setReplyDrafts((d) => ({ ...d, [threadId]: '' }));
      } catch (e) {
        setError(message(e));
      } finally {
        setBusy(false);
      }
    },
    [replyDrafts, itemId],
  );

  const resolve = useCallback(
    async (threadId: string, resolved: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const updated = await api<ThreadDTO>(
          `/api/portal/items/${itemId}/comments/${threadId}`,
          { method: 'PATCH', body: JSON.stringify({ resolved }) },
        );
        setThreads((curr) => curr.map((t) => (t.id === threadId ? updated : t)));
      } catch (e) {
        setError(message(e));
      } finally {
        setBusy(false);
      }
    },
    [itemId],
  );

  const removeComment = useCallback(
    async (threadId: string, commentId: string) => {
      if (!window.confirm('Delete this comment?')) return;
      setBusy(true);
      setError(null);
      try {
        await api(
          `/api/portal/items/${itemId}/comments/${threadId}/replies/${commentId}`,
          { method: 'DELETE' },
        );
        await refresh(); // simplest: re-fetch since deleting the last comment also deletes the thread
      } catch (e) {
        setError(message(e));
      } finally {
        setBusy(false);
      }
    },
    [itemId, refresh],
  );

  const canResolve = useCallback(
    (t: ThreadDTO): boolean => {
      if (!currentUser) return false;
      if (canEditItem) return true;
      return t.createdBy === currentUser.id;
    },
    [currentUser, canEditItem],
  );

  const canDeleteComment = useCallback(
    (c: CommentDTO): boolean => {
      if (!currentUser) return false;
      if (canEditItem) return true;
      return c.authorId === currentUser.id;
    },
    [currentUser, canEditItem],
  );

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-label="Map comments"
      className="absolute right-3 top-16 z-30 flex max-h-[80vh] w-96 flex-col rounded-md border border-border bg-surface-1 shadow-card"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <MessageSquarePlus className="h-4 w-4 text-muted" />
          <h2 className="text-sm font-semibold text-ink-1">Comments</h2>
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" />
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted hover:bg-surface-2 hover:text-ink-1"
          aria-label="Close comments panel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
          />
          Show resolved
        </label>
        <span className="text-xs text-muted">
          {visibleThreads.length}{' '}
          {visibleThreads.length === 1 ? 'thread' : 'threads'}
        </span>
      </div>

      <div className="overflow-y-auto px-2 py-2">
        {visibleThreads.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted">
            {threads.length === 0
              ? 'No comments yet. Start the conversation below.'
              : 'No open threads. Toggle "Show resolved" to see closed ones.'}
          </p>
        ) : (
          <ul className="space-y-3">
            {visibleThreads.map((t) => (
              <li
                key={t.id}
                className={`rounded border px-2 py-2 ${
                  t.resolved
                    ? 'border-border bg-surface-2 opacity-75'
                    : 'border-border bg-surface-1'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-2xs text-muted">
                    Thread opened {formatRelative(t.createdAt)}
                    {t.resolved ? ' • Resolved' : null}
                  </p>
                  {canResolve(t) ? (
                    <button
                      type="button"
                      onClick={() => resolve(t.id, !t.resolved)}
                      disabled={busy}
                      className="flex items-center gap-1 rounded border border-border bg-surface-1 px-1.5 py-0.5 text-2xs text-ink-1 hover:bg-surface-2 disabled:opacity-50"
                    >
                      {t.resolved ? (
                        <>
                          <Undo2 className="h-3 w-3" />
                          Reopen
                        </>
                      ) : (
                        <>
                          <Check className="h-3 w-3" />
                          Resolve
                        </>
                      )}
                    </button>
                  ) : null}
                </div>
                <ul className="mt-1 space-y-1.5">
                  {t.comments.map((c) => (
                    <li key={c.id} className="rounded bg-surface-2 px-2 py-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-2xs font-medium text-ink-1">
                          {c.authorDisplay}
                          <span className="ml-1 font-normal text-muted">
                            {formatRelative(c.createdAt)}
                            {c.editedAt ? ' (edited)' : ''}
                          </span>
                        </p>
                        {canDeleteComment(c) ? (
                          <button
                            type="button"
                            onClick={() => removeComment(t.id, c.id)}
                            disabled={busy}
                            className="rounded p-0.5 text-muted hover:bg-danger/10 hover:text-danger"
                            aria-label="Delete comment"
                            title="Delete comment"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        ) : null}
                      </div>
                      <p className="mt-0.5 whitespace-pre-wrap text-sm text-ink-1">
                        {c.body}
                      </p>
                    </li>
                  ))}
                </ul>
                {!t.resolved && currentUser ? (
                  <div className="mt-2 flex items-end gap-1">
                    <textarea
                      value={replyDrafts[t.id] ?? ''}
                      onChange={(e) =>
                        setReplyDrafts((d) => ({
                          ...d,
                          [t.id]: e.target.value,
                        }))
                      }
                      placeholder="Reply..."
                      rows={2}
                      className="flex-1 rounded border border-border bg-surface-1 px-2 py-1 text-xs text-ink-1"
                    />
                    <button
                      type="button"
                      onClick={() => sendReply(t.id)}
                      disabled={
                        busy || (replyDrafts[t.id] ?? '').trim().length === 0
                      }
                      className="rounded border border-border bg-accent px-2 py-1 text-xs text-accent-on hover:opacity-90 disabled:opacity-50"
                    >
                      <Send className="h-3 w-3" />
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-border px-3 py-2">
        {currentUser ? (
          <div className="flex items-end gap-1">
            <textarea
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              placeholder="Start a new thread..."
              rows={2}
              className="flex-1 rounded border border-border bg-surface-1 px-2 py-1 text-sm text-ink-1"
            />
            <button
              type="button"
              onClick={startThread}
              disabled={busy || draftBody.trim().length === 0}
              className="flex items-center gap-1 rounded border border-border bg-accent px-2 py-1.5 text-sm font-medium text-accent-on hover:opacity-90 disabled:opacity-50"
            >
              <ChevronDown className="h-3.5 w-3.5 rotate-[-90deg]" />
              Post
            </button>
          </div>
        ) : (
          <p className="text-xs text-muted">Sign in to comment on this map.</p>
        )}
        {error ? (
          <p role="alert" className="mt-2 text-xs text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function message(e: unknown): string {
  if (e instanceof Error) return e.message;
  return 'Something went wrong';
}

async function api<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.body && !headers['content-type'] && !headers['Content-Type']) {
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${body || res.statusText}`);
  }
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const diff = Date.now() - then;
  if (diff < 0) return 'just now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(iso).toLocaleDateString();
}
