// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Bring each database in line with the C library it now runs on.
 *
 * Text indexes are sorted by the operating system's collation rules.
 * When the Postgres image moves to a newer glibc (bullseye's 2.31 to
 * trixie's 2.41, #748), those rules can change, and an index built
 * under the old ones may be out of order for the new ones: lookups miss
 * rows and a unique index can let a duplicate in. Postgres notices (it
 * records the collation version per database) and warns on every
 * connection, but fixes nothing by itself.
 *
 * For every database whose recorded version differs from the one the
 * OS provides, this rebuilds its indexes and then records the new
 * version. It also runs the PostGIS extension upgrade wherever the
 * installed version is behind the library in the image. A database
 * that is already current costs one catalog query, so it is safe to
 * run on every start.
 *
 * A failed REINDEX (for example a unique index that now sees two equal
 * keys) throws, and the version is not refreshed, so the next start
 * tries again and the app does not run on an index it cannot trust.
 */

export interface SqlClient {
  query<R = Record<string, unknown>>(sql: string): Promise<{ rows: R[] }>;
  end(): Promise<void>;
}

export interface CollationRefreshResult {
  /** Skipped because the connecting role cannot reindex every database. */
  skipped: boolean;
  reindexed: string[];
  postgisUpgraded: string[];
}

/** Double-quote an identifier for SQL. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export async function refreshCollations(
  connect: (database: string | null) => Promise<SqlClient>,
  log: (line: string) => void,
): Promise<CollationRefreshResult> {
  const result: CollationRefreshResult = { skipped: false, reindexed: [], postgisUpgraded: [] };
  const admin = await connect(null);
  let stale: string[];
  let connectable: string[];
  try {
    const role = await admin.query<{ rolsuper: boolean }>(
      'select rolsuper from pg_roles where rolname = current_user',
    );
    if (!role.rows[0]?.rolsuper) {
      log('collation check skipped: this role is not a superuser');
      result.skipped = true;
      return result;
    }
    const rows = await admin.query<{ datname: string; stale: boolean }>(
      `select datname,
              (datcollversion is not null
               and pg_database_collation_actual_version(oid) is not null
               and datcollversion <> pg_database_collation_actual_version(oid)) as stale
         from pg_database
        where datallowconn
        order by datname`,
    );
    connectable = rows.rows.map((r) => r.datname);
    stale = rows.rows.filter((r) => r.stale).map((r) => r.datname);
  } finally {
    await admin.end();
  }

  for (const db of connectable) {
    const client = await connect(db);
    try {
      if (stale.includes(db)) {
        log(`collation version changed in ${db}: rebuilding its indexes`);
        const started = Date.now();
        await client.query(`reindex database ${quoteIdent(db)}`);
        await client.query(`alter database ${quoteIdent(db)} refresh collation version`);
        log(`rebuilt ${db} in ${Math.round((Date.now() - started) / 1000)} s`);
        result.reindexed.push(db);
      }
      const behind = await client.query<{ behind: boolean }>(
        `select e.extversion <> a.default_version as behind
           from pg_extension e
           join pg_available_extensions a on a.name = e.extname
          where e.extname = 'postgis'`,
      );
      if (behind.rows[0]?.behind) {
        log(`upgrading PostGIS in ${db}`);
        await client.query('select postgis_extensions_upgrade()');
        result.postgisUpgraded.push(db);
      }
    } finally {
      await client.end();
    }
  }
  return result;
}
