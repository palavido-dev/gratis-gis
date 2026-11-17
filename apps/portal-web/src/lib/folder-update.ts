// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Change a folder's member list without touching the rest of its data.
 *
 * PATCH /items/:id replaces `data` wholesale. The items page, the
 * folder rail and the new-item wizard each rebuilt the folder's data
 * as `{ version, childItemIds }`, which deleted a smart folder's saved
 * query for good. They also wrote from a read that could be stale and
 * did not always check the answer.
 *
 * This reads the folder, keeps every key of its data, changes only
 * `childItemIds`, and sends the `updatedAt` it read so the server
 * refuses the write (409) if someone saved in between. On a 409 it
 * reads again and retries a couple of times, so a concurrent add is
 * kept instead of overwritten. Any other failure throws with the
 * server's own sentence.
 */
import { parseApiError } from './api-error';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

type FolderRow = {
  type?: string;
  updatedAt?: string;
  data?: Record<string, unknown> | null;
};

export type FolderUpdateResult = {
  /** False when `change` returned null, so nothing was written. */
  changed: boolean;
};

const MAX_ATTEMPTS = 3;

export function folderChildIds(data: unknown): string[] {
  const ids = (data as { childItemIds?: unknown } | null | undefined)
    ?.childItemIds;
  return Array.isArray(ids)
    ? ids.filter((x): x is string => typeof x === 'string')
    : [];
}

/** The folder's data with only the member list replaced. */
export function withChildIds(
  data: Record<string, unknown> | null | undefined,
  childItemIds: string[],
): Record<string, unknown> {
  return { version: 1, ...(data ?? {}), childItemIds };
}

/**
 * `change` gets the current member list and returns the new one, or
 * null when there is nothing to do. It can run more than once.
 */
export async function updateFolderChildren(
  folderId: string,
  change: (current: string[]) => string[] | null,
  fetchImpl: Fetch = fetch,
): Promise<FolderUpdateResult> {
  const url = `/api/portal/items/${encodeURIComponent(folderId)}`;
  for (let attempt = 1; ; attempt += 1) {
    const getRes = await fetchImpl(url);
    if (!getRes.ok) {
      throw new Error(await parseApiError(getRes, 'Could not load the folder'));
    }
    const folder = (await getRes.json()) as FolderRow;
    // Never write a member list into an item that is not a folder.
    if (folder.type !== 'folder') {
      throw new Error('That item is not a folder.');
    }
    const next = change(folderChildIds(folder.data));
    if (next === null) return { changed: false };
    const body: Record<string, unknown> = {
      data: withChildIds(folder.data, next),
    };
    if (folder.updatedAt) body.expectedUpdatedAt = folder.updatedAt;
    const res = await fetchImpl(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return { changed: true };
    if (res.status === 409 && attempt < MAX_ATTEMPTS) continue;
    throw new Error(await parseApiError(res, 'Could not update the folder'));
  }
}
