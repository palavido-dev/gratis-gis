// SPDX-License-Identifier: AGPL-3.0-or-later
import { adminUsersPageQuery, fetchAllAdminUsers } from './admin-users-paging';

describe('fetchAllAdminUsers', () => {
  it('keeps asking until a short page, so users past the first page load', async () => {
    const users = Array.from({ length: 23 }, (_, i) => `u${i}`);
    const asked: Array<[number, number]> = [];
    const all = await fetchAllAdminUsers(async (first, max) => {
      asked.push([first, max]);
      return users.slice(first, first + max);
    }, 10);
    expect(all).toEqual(users);
    expect(asked).toEqual([
      [0, 10],
      [10, 10],
      [20, 10],
    ]);
  });

  it('asks once more after an exactly full page and stops on the empty one', async () => {
    const all = await fetchAllAdminUsers(
      async (first) => (first === 0 ? ['a', 'b'] : []),
      2,
    );
    expect(all).toEqual(['a', 'b']);
  });

  it('builds the query string', () => {
    expect(adminUsersPageQuery(500, 500)).toBe('first=500&max=500');
  });
});
