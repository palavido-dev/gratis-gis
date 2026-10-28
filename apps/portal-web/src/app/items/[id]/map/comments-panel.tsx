// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { formatDate } from '@/lib/i18n/format';
import { useT } from '@/lib/i18n/locale-context';
import { DEFAULT_LOCALE } from '@/lib/i18n/locales';

/**
 * Comments panel (#155 Phase 1 + 2).
 *
 * A floating overlay on the map editor that lets viewers (not just
 * editors) leave threaded comments on a map. Phase 2 anchors
 * threads to a selected feature or drawing feature via the
 * polymorphic (parentKind, parentId) the server already persists.
 * Map-level threads remain the default when no compose anchor is set.
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
  MapPin,
  MessageSquarePlus,
  Send,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import type { CommentAnchor } from './comment-anchors';

interface CommentDTO {
  id: string;
  threadId: string;
  authorId: string;
  authorDisplay: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
}

export interface ThreadDTO {
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

export type CommentThreadDTO = ThreadDTO;

interface Props {
  itemId: string;
  open: boolean;
  onClose: () => void;
  currentUser: { id: string; displayName: string } | null;
  /** True when the viewer can edit the parent map item. Editors
   *  see resolve / delete actions on every thread; viewers see
   *  them only for their own. */
  canEditItem: boolean;
  /**
   * Optional compose target from the map (selected feature).
   * When set, new threads post with that parentKind / parentId.
   * Cleared by the parent when the selection empties, or locally
   * when the user chooses map-level / a markup feature.
   */
  composeAnchor?: CommentAnchor | null;
  onComposeAnchorChange?: (anchor: CommentAnchor | null | undefined) => void;
  /** Drawing features available to anchor a new thread to. */
  drawingOptions?: Array<{ id: string; label: string }>;
  /** Highlight a thread (e.g. after clicking a map pin). */
  focusThreadId?: string | null;
  /** Notify parent when the thread list changes so pins can refresh. */
  onThreadsChange?: (threads: ThreadDTO[]) => void;
  /** Fired when the user picks a thread in the list (e.g. to fly to pin). */
  onSelectThread?: (thread: ThreadDTO) => void;
}

export function CommentsPanel({
  itemId,
  open,
  onClose,
  currentUser,
  canEditItem,
  composeAnchor = null,
  onComposeAnchorChange,
  drawingOptions = [],
  focusThreadId = null,
  onThreadsChange,
  onSelectThread,
}: Props) {
  const t = useT();
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
      onThreadsChange?.(fresh);
    } catch (e) {
      setError(message(e, t('mapComments.somethingWrong')));
    } finally {
      setLoading(false);
    }
  }, [itemId, t, onThreadsChange]);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const visibleThreads = useMemo(() => {
    if (showResolved) return threads;
    return threads.filter((th) => !th.resolved);
  }, [threads, showResolved]);

  const startThread = useCallback(async () => {
    if (!currentUser) return;
    const body = draftBody.trim();
    if (body.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const payload: {
        body: string;
        parentKind?: string;
        parentId?: string;
      } = { body };
      if (composeAnchor) {
        payload.parentKind = composeAnchor.parentKind;
        payload.parentId = composeAnchor.parentId;
      }
      const created = await api<ThreadDTO>(
        `/api/portal/items/${itemId}/comments`,
        { method: 'POST', body: JSON.stringify(payload) },
      );
      setThreads((curr) => {
        const next = [...curr, created];
        onThreadsChange?.(next);
        return next;
      });
      setDraftBody('');
    } catch (e) {
      setError(message(e, t('mapComments.somethingWrong')));
    } finally {
      setBusy(false);
    }
  }, [currentUser, draftBody, itemId, t, composeAnchor, onThreadsChange]);

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
        setError(message(e, t('mapComments.somethingWrong')));
      } finally {
        setBusy(false);
      }
    },
    [replyDrafts, itemId, t],
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
        setThreads((curr) => {
          const next = curr.map((thread) =>
            thread.id === threadId ? updated : thread,
          );
          onThreadsChange?.(next);
          return next;
        });
      } catch (e) {
        setError(message(e, t('mapComments.somethingWrong')));
      } finally {
        setBusy(false);
      }
    },
    [itemId, t, onThreadsChange],
  );

  const removeComment = useCallback(
    async (threadId: string, commentId: string) => {
      if (!window.confirm(t('mapComments.deleteConfirm'))) return;
      setBusy(true);
      setError(null);
      try {
        await api(
          `/api/portal/items/${itemId}/comments/${threadId}/replies/${commentId}`,
          { method: 'DELETE' },
        );
        await refresh(); // simplest: re-fetch since deleting the last comment also deletes the thread
      } catch (e) {
        setError(message(e, t('mapComments.somethingWrong')));
      } finally {
        setBusy(false);
      }
    },
    [itemId, refresh, t],
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
      aria-label={t('mapComments.panelAria')}
      className="absolute right-14 top-3 z-30 flex max-h-[70vh] w-96 flex-col rounded-md border border-border bg-surface-1 shadow-card max-md:left-3 max-md:right-3 max-md:top-16 max-md:w-auto"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <MessageSquarePlus className="h-4 w-4 text-muted" />
          <h2 className="text-sm font-semibold text-ink-1">
            {t('mapComments.title')}
          </h2>
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" />
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted hover:bg-surface-2 hover:text-ink-1"
          aria-label={t('mapComments.closeAria')}
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
          {t('mapComments.showResolved')}
        </label>
        <span className="text-xs text-muted">
          {t('mapComments.threads', { count: visibleThreads.length })}
        </span>
      </div>

      <div className="overflow-y-auto px-2 py-2">
        {visibleThreads.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted">
            {threads.length === 0
              ? t('mapComments.emptyOpen')
              : t('mapComments.emptyResolved')}
          </p>
        ) : (
          <ul className="space-y-3">
            {visibleThreads.map((thread) => (
              <li
                key={thread.id}
                className={`rounded border px-2 py-2 ${
                  focusThreadId === thread.id
                    ? 'border-accent/50 bg-accent/5'
                    : thread.resolved
                      ? 'border-border bg-surface-2 opacity-75'
                      : 'border-border bg-surface-1'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => onSelectThread?.(thread)}
                    className="min-w-0 flex-1 text-left text-2xs text-muted hover:text-ink-1"
                  >
                    {thread.parentKind !== 'map' ? (
                      <span className="mr-1 inline-flex items-center gap-0.5 rounded bg-surface-2 px-1 py-0.5 text-2xs text-ink-1">
                        <MapPin className="h-2.5 w-2.5" />
                        {thread.parentKind === 'feature'
                          ? t('mapComments.anchorFeature')
                          : thread.parentKind === 'drawing'
                            ? t('mapComments.anchorDrawing')
                            : t('mapComments.anchorLayer')}
                      </span>
                    ) : null}
                    {t('mapComments.threadOpened', {
                      when: formatRelative(thread.createdAt),
                    })}
                    {thread.resolved
                      ? t('mapComments.resolvedSuffix')
                      : null}
                  </button>
                  {canResolve(thread) ? (
                    <button
                      type="button"
                      onClick={() => resolve(thread.id, !thread.resolved)}
                      disabled={busy}
                      className="flex items-center gap-1 rounded border border-border bg-surface-1 px-1.5 py-0.5 text-2xs text-ink-1 hover:bg-surface-2 disabled:opacity-50"
                    >
                      {thread.resolved ? (
                        <>
                          <Undo2 className="h-3 w-3" />
                          {t('mapComments.reopen')}
                        </>
                      ) : (
                        <>
                          <Check className="h-3 w-3" />
                          {t('mapComments.resolve')}
                        </>
                      )}
                    </button>
                  ) : null}
                </div>
                <ul className="mt-1 space-y-1.5">
                  {thread.comments.map((c) => (
                    <li key={c.id} className="rounded bg-surface-2 px-2 py-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-2xs font-medium text-ink-1">
                          {c.authorDisplay}
                          <span className="ml-1 font-normal text-muted">
                            {formatRelative(c.createdAt)}
                            {c.editedAt
                              ? t('mapComments.editedSuffix')
                              : ''}
                          </span>
                        </p>
                        {canDeleteComment(c) ? (
                          <button
                            type="button"
                            onClick={() => removeComment(thread.id, c.id)}
                            disabled={busy}
                            className="rounded p-0.5 text-muted hover:bg-danger/10 hover:text-danger"
                            aria-label={t('mapComments.deleteAria')}
                            title={t('mapComments.deleteAria')}
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
                {!thread.resolved && currentUser ? (
                  <div className="mt-2 flex items-end gap-1">
                    <textarea
                      value={replyDrafts[thread.id] ?? ''}
                      onChange={(e) =>
                        setReplyDrafts((d) => ({
                          ...d,
                          [thread.id]: e.target.value,
                        }))
                      }
                      placeholder={t('mapComments.replyPlaceholder')}
                      rows={2}
                      className="flex-1 rounded border border-border bg-surface-1 px-2 py-1 text-xs text-ink-1"
                    />
                    <button
                      type="button"
                      onClick={() => sendReply(thread.id)}
                      disabled={
                        busy ||
                        (replyDrafts[thread.id] ?? '').trim().length === 0
                      }
                      className="rounded border border-border bg-accent px-2 py-1 text-xs text-accent-foreground hover:opacity-90 disabled:opacity-50"
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
          <div className="space-y-1.5">
            {composeAnchor ? (
              <div className="flex items-center gap-1.5 text-2xs text-ink-1">
                <MapPin className="h-3 w-3 text-accent" />
                <span className="min-w-0 flex-1 truncate">
                  {t('mapComments.composeOn', { label: composeAnchor.label })}
                </span>
                <button
                  type="button"
                  onClick={() => onComposeAnchorChange?.(null)}
                  className="rounded px-1 text-muted hover:bg-surface-2 hover:text-ink-1"
                >
                  {t('mapComments.composeMapLevel')}
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-1.5 text-2xs text-muted">
                <span>{t('mapComments.composeHint')}</span>
                {drawingOptions.length > 0 ? (
                  <select
                    className="max-w-[12rem] truncate rounded border border-border bg-surface-1 px-1 py-0.5 text-2xs text-ink-1"
                    defaultValue=""
                    onChange={(e) => {
                      const id = e.target.value;
                      if (!id) return;
                      const opt = drawingOptions.find((d) => d.id === id);
                      if (!opt) return;
                      onComposeAnchorChange?.({
                        parentKind: 'drawing',
                        parentId: opt.id,
                        label: opt.label,
                      });
                      e.target.value = '';
                    }}
                    aria-label={t('mapComments.anchorDrawingPick')}
                  >
                    <option value="">
                      {t('mapComments.anchorDrawingPick')}
                    </option>
                    {drawingOptions.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
            )}
            <div className="flex items-end gap-1">
              <textarea
                value={draftBody}
                onChange={(e) => setDraftBody(e.target.value)}
                placeholder={
                  composeAnchor
                    ? t('mapComments.newAnchoredPlaceholder')
                    : t('mapComments.newThreadPlaceholder')
                }
                rows={2}
                className="flex-1 rounded border border-border bg-surface-1 px-2 py-1 text-sm text-ink-1"
              />
              <button
                type="button"
                onClick={startThread}
                disabled={busy || draftBody.trim().length === 0}
                className="flex items-center gap-1 rounded border border-border bg-accent px-2 py-1.5 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
              >
                <ChevronDown className="h-3.5 w-3.5 -rotate-90" />
                {t('mapComments.post')}
              </button>
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted">
            {t('mapComments.signInToComment')}
          </p>
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

function message(e: unknown, fallback: string): string {
  if (e instanceof Error) return e.message;
  return fallback;
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
  return formatDate(iso, DEFAULT_LOCALE);
}
