// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Retry a request the API turned away for rate limiting (429).
 *
 * The items page's bulk actions send one request per selected item,
 * and the API allows a few hundred requests a minute. Past that every
 * 429 was counted as an item the user could not manage. This waits
 * for the time the server names in Retry-After (bounded) and tries
 * again, so a large selection finishes instead of half failing.
 */

const DEFAULT_WAIT_MS = 5_000;
const MAX_WAIT_MS = 60_000;

export function retryAfterMs(res: Response): number {
  const raw = res.headers.get('retry-after');
  const seconds = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_WAIT_MS;
  return Math.min(seconds * 1000, MAX_WAIT_MS);
}

export async function fetchWithThrottleRetry(
  send: () => Promise<Response>,
  opts: {
    attempts?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<Response> {
  const attempts = opts.attempts ?? 4;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let res = await send();
  for (let i = 1; i < attempts && res.status === 429; i += 1) {
    await sleep(retryAfterMs(res));
    res = await send();
  }
  return res;
}
