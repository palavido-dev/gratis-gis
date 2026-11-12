// SPDX-License-Identifier: AGPL-3.0-or-later

/** Users asked for per request. The API caps `max` at 1000. */
export const ADMIN_USERS_PAGE = 500;

/** Stop after this many pages so a broken API cannot loop forever. */
const MAX_PAGES = 40;

/**
 * Load every user of the admin's org from GET /admin/users, page by
 * page. The page used to ask for `max=200` once, so anyone past the
 * first 200 could not be found, edited, disabled or deleted, and the
 * search box (which filters loaded rows) could not find them either.
 */
export async function fetchAllAdminUsers<T>(
  fetchPage: (first: number, max: number) => Promise<T[]>,
  pageSize = ADMIN_USERS_PAGE,
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await fetchPage(page * pageSize, pageSize);
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

/** Query string for one page of GET /admin/users. */
export function adminUsersPageQuery(first: number, max: number): string {
  return `first=${first}&max=${max}`;
}
