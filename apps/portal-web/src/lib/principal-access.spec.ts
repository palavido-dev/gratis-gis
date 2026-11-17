// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  fetchPrincipalAccess,
  hasAccess,
  withGrant,
} from './principal-access';

const bob = { type: 'user' as const, id: 'bob' };
const crew = { type: 'group' as const, id: 'crew' };

function okJson(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

describe('fetchPrincipalAccess', () => {
  it('asks once for a small set and returns the answers', async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      return okJson({ i1: { 'user:bob': false, 'group:crew': true } });
    }) as unknown as typeof fetch;
    const out = await fetchPrincipalAccess(['i1', 'i1'], [bob, crew], fake);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/api/portal/items/principal-access?ids=i1');
    expect(decodeURIComponent(calls[0]!)).toContain('principals=user:bob,group:crew');
    expect(hasAccess(out, 'i1', bob)).toBe(false);
    expect(hasAccess(out, 'i1', crew)).toBe(true);
  });

  it('splits past the server caps and merges the chunks', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `i${i}`);
    const principals = Array.from({ length: 51 }, (_, i) => ({
      type: 'user' as const,
      id: `u${i}`,
    }));
    let calls = 0;
    const fake = (async () => {
      calls += 1;
      return okJson({});
    }) as unknown as typeof fetch;
    await fetchPrincipalAccess(ids, principals, fake);
    expect(calls).toBe(4);
  });

  it('asks nothing without items or principals', async () => {
    const fake = jest.fn() as unknown as typeof fetch;
    expect(await fetchPrincipalAccess([], [bob], fake)).toEqual({});
    expect(await fetchPrincipalAccess(['i1'], [], fake)).toEqual({});
    expect(fake).not.toHaveBeenCalled();
  });

  it('treats a failed request as unknown, not as a gap', async () => {
    const fake = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const out = await fetchPrincipalAccess(['i1'], [bob], fake);
    expect(hasAccess(out, 'i1', bob)).toBe(true);
  });
});

describe('withGrant', () => {
  it('turns a no into a yes for one pair only', () => {
    const start = { i1: { 'user:bob': false, 'group:crew': false } };
    const next = withGrant(start, 'i1', bob);
    expect(hasAccess(next, 'i1', bob)).toBe(true);
    expect(hasAccess(next, 'i1', crew)).toBe(false);
    expect(hasAccess(start, 'i1', bob)).toBe(false);
  });
});
