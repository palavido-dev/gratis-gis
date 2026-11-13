// SPDX-License-Identifier: AGPL-3.0-or-later
// Paging for an item's comment threads.
//
// GET /items/:id/comments returns the newest 200 threads (oldest
// first inside the page). When older threads exist, the API sets
// `X-Next-Cursor`; passing it back as `?before=` returns the page
// before that. The body stays a plain array so older callers work.
import { apiErrorMessage } from './api-error';

export interface CommentPage<T> {
  threads: T[];
  /** Cursor for the next older page, or null when this is the oldest. */
  nextCursor: string | null;
}

export async function fetchCommentPage<T>(
  itemId: string,
  before: string | null = null,
  fetchImpl: typeof fetch = fetch,
): Promise<CommentPage<T>> {
  const qs = before ? `?before=${encodeURIComponent(before)}` : '';
  const res = await fetchImpl(`/api/portal/items/${itemId}/comments${qs}`);
  if (!res.ok) throw new Error(await apiErrorMessage(res));
  const threads = (await res.json()) as T[];
  return { threads, nextCursor: res.headers.get('x-next-cursor') || null };
}

/**
 * Puts an older page in front of the threads already shown. A thread
 * created while the user read could shift the page edges, so ids
 * already present are not added twice.
 */
export function prependOlderThreads<T extends { id: string }>(
  current: readonly T[],
  older: readonly T[],
): T[] {
  const have = new Set(current.map((t) => t.id));
  return [...older.filter((t) => !have.has(t.id)), ...current];
}
