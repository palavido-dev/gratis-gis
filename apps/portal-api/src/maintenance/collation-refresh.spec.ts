// SPDX-License-Identifier: AGPL-3.0-or-later
import { quoteIdent, refreshCollations, type SqlClient } from './collation-refresh.js';

type Db = { name: string; stale: boolean; postgisBehind?: boolean; reindexFails?: boolean };

/** A fake cluster: records every statement per database. */
function cluster(dbs: Db[], opts: { superuser?: boolean } = {}) {
  const sent: Array<{ db: string | null; sql: string }> = [];
  const connect = async (db: string | null): Promise<SqlClient> => ({
    async query<R>(sql: string) {
      sent.push({ db, sql });
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('select rolsuper')) {
        return { rows: [{ rolsuper: opts.superuser ?? true }] as R[] };
      }
      if (s.includes('from pg_database')) {
        return { rows: dbs.map((d) => ({ datname: d.name, stale: d.stale })) as R[] };
      }
      if (s.includes("e.extname = 'postgis'")) {
        const d = dbs.find((x) => x.name === db);
        return { rows: (d?.postgisBehind === undefined ? [] : [{ behind: d.postgisBehind }]) as R[] };
      }
      if (s.startsWith('reindex') && dbs.find((x) => x.name === db)?.reindexFails) {
        throw new Error('could not create unique index');
      }
      return { rows: [] as R[] };
    },
    async end() {},
  });
  return { sent, connect };
}

const quiet = () => undefined;

describe('refreshCollations', () => {
  it('rebuilds only the databases whose collation version moved, then records the new one', async () => {
    const c = cluster([
      { name: 'gratisgis', stale: true, postgisBehind: false },
      { name: 'keycloak', stale: false },
    ]);
    const result = await refreshCollations(c.connect, quiet);
    expect(result.reindexed).toEqual(['gratisgis']);
    const onGratis = c.sent.filter((s) => s.db === 'gratisgis').map((s) => s.sql);
    expect(onGratis).toContain('reindex database "gratisgis"');
    expect(onGratis).toContain('alter database "gratisgis" refresh collation version');
    // Order matters: never record the new version before the rebuild.
    expect(onGratis.indexOf('reindex database "gratisgis"')).toBeLessThan(
      onGratis.indexOf('alter database "gratisgis" refresh collation version'),
    );
    expect(c.sent.some((s) => s.db === 'keycloak' && s.sql.startsWith('reindex'))).toBe(false);
  });

  it('does nothing but read when every database is current', async () => {
    const c = cluster([{ name: 'gratisgis', stale: false, postgisBehind: false }]);
    const result = await refreshCollations(c.connect, quiet);
    expect(result).toEqual({ skipped: false, reindexed: [], postgisUpgraded: [] });
    expect(c.sent.every((s) => /^\s*select/i.test(s.sql))).toBe(true);
  });

  it('upgrades PostGIS where the installed version is behind the library', async () => {
    const c = cluster([
      { name: 'gratisgis', stale: false, postgisBehind: true },
      { name: 'keycloak', stale: false },
    ]);
    const result = await refreshCollations(c.connect, quiet);
    expect(result.postgisUpgraded).toEqual(['gratisgis']);
    expect(c.sent).toContainEqual({ db: 'gratisgis', sql: 'select postgis_extensions_upgrade()' });
  });

  it('leaves the version unrecorded and throws when a rebuild fails, so the next start retries', async () => {
    const c = cluster([{ name: 'gratisgis', stale: true, reindexFails: true }]);
    await expect(refreshCollations(c.connect, quiet)).rejects.toThrow('unique index');
    expect(c.sent.some((s) => s.sql.includes('refresh collation version'))).toBe(false);
  });

  it('skips without touching anything when the role is not a superuser', async () => {
    const c = cluster([{ name: 'gratisgis', stale: true }], { superuser: false });
    const result = await refreshCollations(c.connect, quiet);
    expect(result.skipped).toBe(true);
    expect(c.sent).toHaveLength(1);
  });

  it('quotes database names', () => {
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });
});
