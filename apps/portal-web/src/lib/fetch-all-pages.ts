// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Read a paged `/api/portal/items` list to the end, up to a cap.
 *
 * The list endpoint returns at most `limit` rows (500 when the caller
 * sends none, 1000 at most) and the full count in `X-Total-Count`.
 * Pickers that took only the first response silently lost everything
 * past row 500, and the folder tree, which is computed from the whole
 * folder list, showed children as roots when their parent fell off
 * the page.
 *
 * `ok` is false when any page failed. `truncated` is true when rows
 * exist past `maxRows`, so the caller can ask the user to search.
 */
export interface AllPages<T> {
  rows: T[];
  total: number;
  truncated: boolean;
  ok: boolean;
}

export async function fetchAllPages<T>(
  url: string,
  opts: {
    signal?: AbortSignal;
    pageSize?: number;
    maxRows?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<AllPages<T>> {
  const pageSize = opts.pageSize ?? 1000;
  const maxRows = opts.maxRows ?? 5000;
  const doFetch = opts.fetchImpl ?? fetch;
  const rows: T[] = [];
  let total = 0;
  for (;;) {
    const sep = url.includes('?') ? '&' : '?';
    const res = await doFetch(
      `${url}${sep}limit=${pageSize}&offset=${rows.length}`,
      opts.signal ? { signal: opts.signal } : undefined,
    );
    if (!res.ok) return { rows, total, truncated: false, ok: false };
    const page = (await res.json()) as T[];
    const header = Number.parseInt(res.headers.get('X-Total-Count') ?? '', 10);
    total = Number.isFinite(header) ? header : rows.length + page.length;
    rows.push(...page);
    if (page.length < pageSize || rows.length >= total) break;
    if (rows.length >= maxRows) {
      return { rows, total, truncated: true, ok: true };
    }
  }
  return { rows, total, truncated: false, ok: true };
}
