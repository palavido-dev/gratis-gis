// SPDX-License-Identifier: AGPL-3.0-or-later
import { fetchCommentPage, prependOlderThreads } from './comment-pages';

describe('fetchCommentPage', () => {
  it('reads the cursor header and passes before= through', async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify([{ id: 't1' }]), {
        status: 200,
        headers: { 'x-next-cursor': 't1' },
      });
    }) as unknown as typeof fetch;
    const page = await fetchCommentPage<{ id: string }>('item-1', 'c 9', fake);
    expect(calls).toEqual(['/api/portal/items/item-1/comments?before=c%209']);
    expect(page).toEqual({ threads: [{ id: 't1' }], nextCursor: 't1' });
  });

  it('reports no cursor on the oldest page', async () => {
    const fake = (async () =>
      new Response('[]', { status: 200 })) as unknown as typeof fetch;
    const page = await fetchCommentPage('item-1', null, fake);
    expect(page.nextCursor).toBeNull();
  });
});

describe('prependOlderThreads', () => {
  it('puts older threads first and skips ids already shown', () => {
    const out = prependOlderThreads(
      [{ id: 'b' }, { id: 'c' }],
      [{ id: 'a' }, { id: 'b' }],
    );
    expect(out.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });
});
