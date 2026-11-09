// SPDX-License-Identifier: AGPL-3.0-or-later
import { loadNotificationsAdmin } from './admin-notifications-load';

const http = (status: number) =>
  Object.assign(new Error(`HTTP ${status}`), { status });

const ok = <V>(v: V) => () => Promise.resolve(v);
const fail = (status: number) => () => Promise.reject(http(status));

describe('loadNotificationsAdmin', () => {
  it('gives a non-operator admin their templates and defaults', async () => {
    const out = await loadNotificationsAdmin({
      stats: fail(403),
      recent: fail(403),
      smtp: fail(403),
      defaults: ok({ rows: ['d'] }),
      templates: ok({ rows: ['t'] }),
    });
    expect(out.operator).toBe(false);
    expect(out.error).toBeNull();
    expect(out.defaults).toEqual(['d']);
    expect(out.templateOverrides).toEqual(['t']);
    expect(out.stats).toBeNull();
    expect(out.smtp).toBeNull();
    expect(out.recent).toEqual([]);
  });

  it('loads everything for the operator', async () => {
    const out = await loadNotificationsAdmin({
      stats: ok('s'),
      recent: ok(['r']),
      smtp: ok('m'),
      defaults: ok({ rows: [] }),
      templates: ok({ rows: [] }),
    });
    expect(out).toMatchObject({ operator: true, stats: 's', smtp: 'm', error: null });
  });

  it('reports a failure that is not a 403', async () => {
    const out = await loadNotificationsAdmin({
      stats: ok('s'),
      recent: ok([]),
      smtp: fail(500),
      defaults: ok({ rows: [] }),
      templates: ok({ rows: [] }),
    });
    expect(out.operator).toBe(true);
    expect((out.error as { status: number }).status).toBe(500);
    expect(out.smtp).toBeNull();
  });

  it('reports a 403 on the org-scoped templates as an error', async () => {
    const out = await loadNotificationsAdmin({
      stats: fail(403),
      recent: fail(403),
      smtp: fail(403),
      defaults: ok({ rows: [] }),
      templates: fail(403),
    });
    expect(out.error).not.toBeNull();
    expect(out.templateOverrides).toBeNull();
  });
});
