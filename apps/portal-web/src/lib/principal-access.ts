// SPDX-License-Identifier: AGPL-3.0-or-later
// Ask the server whether principals can read items.
//
// Item reads only carry the share roster for the owner and admins, so
// a sharing surface can no longer work out "can this sharee open that
// dependency" from other items' share lists. The server answers it
// instead, yes or no per pair, through /items/principal-access.

/** Server caps; larger asks are split into several requests. */
const MAX_IDS = 100;
const MAX_PRINCIPALS = 50;

export interface AccessPrincipal {
  type: 'user' | 'group';
  id: string;
}

/** itemId -> `user:<id>` or `group:<id>` -> can read. */
export type AccessAnswers = Record<string, Record<string, boolean>>;

export function accessKey(p: AccessPrincipal): string {
  return `${p.type}:${p.id}`;
}

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Fetch the answers for every (item, principal) pair. A failed chunk
 * leaves its pairs out, which `hasAccess` reads as "no gap": a
 * network error should not flag every dependency as broken.
 */
export async function fetchPrincipalAccess(
  itemIds: readonly string[],
  principals: readonly AccessPrincipal[],
  fetchImpl: typeof fetch = fetch,
): Promise<AccessAnswers> {
  const ids = Array.from(new Set(itemIds));
  const keys = Array.from(new Set(principals.map(accessKey)));
  const out: AccessAnswers = {};
  if (ids.length === 0 || keys.length === 0) return out;
  const requests: Array<Promise<void>> = [];
  for (const idChunk of chunks(ids, MAX_IDS)) {
    for (const keyChunk of chunks(keys, MAX_PRINCIPALS)) {
      const url =
        `/api/portal/items/principal-access?ids=${encodeURIComponent(idChunk.join(','))}` +
        `&principals=${encodeURIComponent(keyChunk.join(','))}`;
      requests.push(
        (async () => {
          try {
            const res = await fetchImpl(url);
            if (!res.ok) return;
            const body = (await res.json()) as AccessAnswers;
            for (const [itemId, row] of Object.entries(body)) {
              out[itemId] = { ...(out[itemId] ?? {}), ...row };
            }
          } catch {
            /* non-fatal: pairs stay unknown */
          }
        })(),
      );
    }
  }
  await Promise.all(requests);
  return out;
}

/**
 * True unless the server said no. Unknown pairs (not asked yet, item
 * not readable by the caller, principal not resolvable) count as
 * access so they raise no warning.
 */
export function hasAccess(
  answers: AccessAnswers | null | undefined,
  itemId: string,
  p: AccessPrincipal,
): boolean {
  return answers?.[itemId]?.[accessKey(p)] !== false;
}

/** Copy of `answers` with one pair marked as granted. */
export function withGrant(
  answers: AccessAnswers,
  itemId: string,
  p: AccessPrincipal,
): AccessAnswers {
  return {
    ...answers,
    [itemId]: { ...(answers[itemId] ?? {}), [accessKey(p)]: true },
  };
}
