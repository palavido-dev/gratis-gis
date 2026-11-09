// SPDX-License-Identifier: AGPL-3.0-or-later
import { isStaleItemSave, savedUpdatedAt, withExpectedUpdatedAt } from './item-version';

describe('item version guard', () => {
  it('adds expectedUpdatedAt only when a version is known', () => {
    expect(withExpectedUpdatedAt({ data: 1 }, '2026-11-01T00:00:00.000Z')).toEqual({
      data: 1,
      expectedUpdatedAt: '2026-11-01T00:00:00.000Z',
    });
    expect(withExpectedUpdatedAt({ data: 1 }, null)).toEqual({ data: 1 });
    expect(withExpectedUpdatedAt({ data: 1 }, '')).toEqual({ data: 1 });
  });

  it('reads the saved version and recognizes a stale save', async () => {
    const ok = new Response(JSON.stringify({ updatedAt: 'v2' }), { status: 200 });
    expect(await savedUpdatedAt(ok)).toBe('v2');
    expect(await ok.json()).toEqual({ updatedAt: 'v2' });
    expect(await savedUpdatedAt(new Response('not json', { status: 200 }))).toBeNull();
    expect(isStaleItemSave(new Response('', { status: 409 }))).toBe(true);
    expect(isStaleItemSave(new Response('', { status: 400 }))).toBe(false);
  });
});
