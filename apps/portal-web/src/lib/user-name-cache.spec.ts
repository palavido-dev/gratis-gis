// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  getCachedUserName,
  prefetchUserNames,
  resetUserNameCacheForTests,
} from './user-name-cache';

function idsOf(url: string): string[] {
  return decodeURIComponent(new URL(url, 'http://x').searchParams.get('ids') ?? '').split(',');
}

beforeEach(() => {
  jest.useFakeTimers();
  resetUserNameCacheForTests();
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

async function settle() {
  jest.advanceTimersByTime(60);
  // Let the fetch promise chain run.
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('user name cache', () => {
  it('does not ask again for an id the server did not return', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const ids = idsOf(String(url));
      const rows = ids
        .filter((id) => id === 'known')
        .map((id) => ({ id, username: 'ada', fullName: 'Ada L' }));
      return new Response(JSON.stringify(rows), { status: 200 });
    });
    getCachedUserName('known');
    getCachedUserName('stranger');
    await settle();
    expect(getCachedUserName('known')).toBe('Ada L');
    getCachedUserName('stranger');
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('splits more than 200 ids into several requests', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('[]', { status: 200 }));
    prefetchUserNames(Array.from({ length: 450 }, (_, i) => `u${i}`));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const sizes = fetchMock.mock.calls.map((c) => idsOf(String(c[0])).length);
    expect(sizes).toEqual([200, 200, 50]);
  });
});
