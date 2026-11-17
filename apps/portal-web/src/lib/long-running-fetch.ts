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

/**
 * Long-running upstream calls (ingest, per-layer import, whole-layer
 * export, backup restore) go through longRunningFetch, which has a
 * 15 min budget instead of the default fetch timeouts, so a county-scale parcel
 * ingest or a GeoParquet export of the same layer can finish. Normal
 * API calls keep the tight defaults and fail fast. See
 * src/lib/long-running-fetch.ts for why it is undici's own fetch.
 *
 * Matches v3 per-layer ingest, v2 ingest, the wizard probe path,
 * the per-layer GeoParquet export, admin backup restore (#233) and
 * creating a backup.
 * Conservative: only widens for endpoints we know can take minutes.
 */
export function isLongRunningPath(suffix: string): boolean {
  return (
    /^items\/[^/]+\/layers\/[^/]+\/import$/.test(suffix) ||
    /^items\/[^/]+\/layers\/[^/]+\/geoparquet$/.test(suffix) ||
    /^items\/[^/]+\/ingest$/.test(suffix) ||
    suffix === 'ingest/probe' ||
    suffix === 'ingest/stage' ||
    // #573: copies the finished upload out of storage and probes it,
    // which takes minutes for a multi-GB file.
    suffix === 'ingest/upload/complete' ||
    // #573: purging a data layer deletes all of its rows, minutes for
    // a layer with millions of features.
    /^items\/[^/]+\/purge$/.test(suffix) ||
    // #233: pg_restore + full MinIO refill routinely exceeds undici's
    // 30s default; without this the BFF aborts mid-restore.
    /^admin\/backup\/runs\/[^/]+\/restore$/.test(suffix) ||
    // POST admin/backup/runs waits for the whole pg_dump and object
    // archive. Under the default timeout the BFF answered 502 while
    // the backup kept running, and a retry then got 409.
    suffix === 'admin/backup/runs'
  );
}
