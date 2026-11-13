// SPDX-License-Identifier: AGPL-3.0-or-later
import { fetchAllPages } from './fetch-all-pages';

function fakeList(total: number, fail?: number) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    const u = new URL(url, 'http://x');
    const limit = Number(u.searchParams.get('limit'));
    const offset = Number(u.searchParams.get('offset'));
    if (fail !== undefined && offset >= fail) {
      return new Response('no', { status: 500 });
    }
    const n = Math.max(0, Math.min(limit, total - offset));
    const body = Array.from({ length: n }, (_, i) => ({ i: offset + i }));
    return new Response(JSON.stringify(body), {
      headers: { 'X-Total-Count': String(total) },
    });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe('fetchAllPages', () => {
  it('reads every page past the first', async () => {
    const { calls, impl } = fakeList(1200);
    const out = await fetchAllPages<{ i: number }>('/api/portal/items?type=folder', {
      pageSize: 500,
      fetchImpl: impl,
    });
    expect(out.rows).toHaveLength(1200);
    expect(out.rows[1199]).toEqual({ i: 1199 });
    expect(out.truncated).toBe(false);
    expect(calls[1]).toBe('/api/portal/items?type=folder&limit=500&offset=500');
  });

  it('stops at the cap and says so', async () => {
    const { impl } = fakeList(5000);
    const out = await fetchAllPages('/api/portal/items', {
      pageSize: 1000,
      maxRows: 2000,
      fetchImpl: impl,
    });
    expect(out.rows).toHaveLength(2000);
    expect(out.truncated).toBe(true);
    expect(out.total).toBe(5000);
  });

  it('reports a failed page', async () => {
    const { impl } = fakeList(3000, 1000);
    const out = await fetchAllPages('/api/portal/items', { fetchImpl: impl });
    expect(out.ok).toBe(false);
    expect(out.rows).toHaveLength(1000);
  });
});
