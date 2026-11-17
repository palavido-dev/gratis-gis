// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Apply folder sharing to all items": what is copied, and how one
 * copy is sent.
 */
import type { ItemShare } from '@gratis-gis/shared-types';

/**
 * The share POST body for one folder share, or null when the share
 * has already ended. The expiry rides along: leaving it off turned a
 * share that ends on Friday into an item share that never ends, and
 * an already expired folder share (still in the list, it is only
 * filtered at access time) into a live one.
 */
export function shareCopyBody(
  share: ItemShare,
  now: Date = new Date(),
): Record<string, unknown> | null {
  if (share.expiresAt) {
    const ends = Date.parse(share.expiresAt);
    if (Number.isFinite(ends) && ends <= now.getTime()) return null;
  }
  const body: Record<string, unknown> = {
    principalType: share.principalType,
    principalId: share.principalId,
    permission: share.permission,
  };
  if (share.geoBoundaryId) {
    body.geoBoundaryId = share.geoBoundaryId;
  } else if (share.geoLimit) {
    body.geoLimit = share.geoLimit;
  }
  if (share.expiresAt) body.expiresAt = share.expiresAt;
  return body;
}

export type ShareCopyOutcome = 'ok' | 'denied' | 'error';

const MAX_ATTEMPTS = 3;
/** Never wait longer than this per retry, whatever Retry-After says. */
const MAX_WAIT_MS = 30_000;

/**
 * POST one share copy. A 429 or a 5xx is the server being busy, not
 * the caller lacking rights, so it is retried after a pause and, if it
 * still fails, reported as an error rather than as a permission skip.
 */
export async function postShareCopy(
  url: string,
  body: Record<string, unknown>,
  deps: {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<ShareCopyOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      if (attempt === MAX_ATTEMPTS) return 'error';
      await sleep(1000 * attempt);
      continue;
    }
    if (res.ok) return 'ok';
    if (res.status === 429 || res.status >= 500) {
      if (attempt === MAX_ATTEMPTS) return 'error';
      const header = Number(res.headers.get('retry-after'));
      const wait =
        Number.isFinite(header) && header > 0 ? header * 1000 : 2000 * attempt;
      await sleep(Math.min(wait, MAX_WAIT_MS));
      continue;
    }
    // 403 (no admin on the item), 400/404 (bad principal, moved item).
    return 'denied';
  }
  return 'error';
}
