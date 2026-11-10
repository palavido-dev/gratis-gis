// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fetch() for BFF calls that can take minutes (#573).
 *
 * The BFF used to hand an Agent from the `undici` npm package to the
 * fetch() built into Node. That only works while both come from the
 * same undici major. Node 24 ships undici 7; the npm package moved to
 * 8 in 1.3.0, and from then on every call routed here failed at once
 * with "fetch failed" (cause: "invalid onRequestStart method"). The
 * browser saw "The portal API could not be reached. (502)" right after
 * an upload finished, on imports, GeoParquet exports and backup
 * restores alike.
 *
 * The fix is to take fetch and Agent from the same package, so they
 * can never drift apart again, whatever Node or undici version ships.
 *
 * Loaded on first use, never at module load: undici's module body
 * references Node 22+ builtins, and `next build` evaluates every route
 * module while collecting page data, so a static import once broke the
 * build on an older Node.
 */

import type * as Undici from 'undici';

export const LONG_RUNNING_TIMEOUT_MS = 15 * 60 * 1000;

type UndiciModule = typeof Undici;

let loaded: Promise<{
  fetch: UndiciModule['fetch'];
  agent: InstanceType<UndiciModule['Agent']>;
}> | null = null;

function load() {
  loaded ??= import('undici').then((u) => ({
    fetch: u.fetch,
    agent: new u.Agent({
      headersTimeout: LONG_RUNNING_TIMEOUT_MS,
      bodyTimeout: LONG_RUNNING_TIMEOUT_MS,
      connectTimeout: 30 * 1000,
    }),
  }));
  return loaded;
}

/**
 * Same contract as the global fetch, with a 15 minute budget for the
 * response headers and between body chunks. The result is a standard
 * WHATWG Response (undici's own), so callers can stream `body` on.
 */
export async function longRunningFetch(url: string, init: RequestInit): Promise<Response> {
  const { fetch, agent } = await load();
  // undici's RequestInit is the same shape as the DOM one plus
  // `dispatcher`; the types differ only in name.
  const res = await fetch(url, { ...(init as object), dispatcher: agent } as Parameters<
    UndiciModule['fetch']
  >[1]);
  return res as unknown as Response;
}

/**
 * The text to log for a failed fetch. Node and undici both throw a
 * bare "fetch failed" and put the real reason in `cause`; the BFF
 * logged only the bare message, which is why #573 took a round trip
 * to diagnose.
 */
export function fetchFailureReason(err: unknown): string {
  // Duck-typed, not instanceof: undici's errors can come from another
  // realm (Node's bundled copy, or a test VM), where instanceof fails.
  const asError = (v: unknown): { message: string; code?: unknown; cause?: unknown } | null =>
    v !== null && typeof v === 'object' && typeof (v as { message?: unknown }).message === 'string'
      ? (v as { message: string })
      : null;
  const e = asError(err);
  if (!e) return String(err);
  const cause = e.cause;
  const c = asError(cause);
  if (c) {
    return `${e.message}: ${typeof c.code === 'string' ? `${c.code} ` : ''}${c.message}`;
  }
  if (cause !== undefined) return `${e.message}: ${String(cause)}`;
  return e.message;
}
