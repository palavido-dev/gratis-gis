// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Small helpers for client loops that send one request per row.
 *
 * portal-api throttles every route at 300 requests a minute per
 * address. A bulk action that fires one request per selected row,
 * all at once, trips that limit on a large selection and then every
 * other request the user makes fails too. These two helpers keep such
 * loops polite: a fixed number in flight at a time, and a 429 or 5xx
 * waited out and retried instead of read as a final answer.
 */

/**
 * Run `fn` over `items` with at most `limit` calls in flight. Results
 * come back in input order. `fn` should not throw; if it does, the
 * returned promise rejects like Promise.all would.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  }
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}

const DEFAULT_ATTEMPTS = 4;
/** Never wait longer than this per retry, whatever Retry-After says. */
const MAX_WAIT_MS = 60_000;

export interface FetchRetryingDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Total tries, first one included. */
  attempts?: number;
}

/** True for answers that mean "busy, try later" rather than "no". */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * fetch, but a 429, a 5xx or a network error is retried after a pause
 * (Retry-After when the server sends one, else a growing backoff).
 * Returns the last Response, which may still be a failure, so the
 * caller decides what a final 429 means. Rethrows the last network
 * error when every attempt failed to connect.
 */
export async function fetchRetrying(
  url: string,
  init: RequestInit | undefined,
  deps: FetchRetryingDeps = {},
): Promise<Response> {
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = Math.max(1, deps.attempts ?? DEFAULT_ATTEMPTS);
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, init);
    } catch (err) {
      if (attempt >= attempts) throw err;
      await sleep(Math.min(1000 * 2 ** (attempt - 1), MAX_WAIT_MS));
      continue;
    }
    if (!isRetryableStatus(res.status) || attempt >= attempts) return res;
    const header = Number(res.headers.get('retry-after'));
    const wait =
      Number.isFinite(header) && header > 0
        ? header * 1000
        : 2000 * 2 ** (attempt - 1);
    // Drain the body so the connection can be reused.
    await res.body?.cancel().catch(() => {});
    await sleep(Math.min(wait, MAX_WAIT_MS));
  }
}
