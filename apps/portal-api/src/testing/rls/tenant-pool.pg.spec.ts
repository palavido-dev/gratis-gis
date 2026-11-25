// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Trial of the connection stamp and row-level security, against real
// PostgreSQL. Not wired into the app: the test builds its own roles,
// helper functions and policies in a database of its own.
//
// The app role here is a login with no BYPASSRLS that owns nothing,
// so the policies apply to it. The system role has BYPASSRLS.

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client, Pool, type PoolClient } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';

import { runAsAnonymous, runAsOrg, runAsSystem } from '../../common/tenant-context.js';
import { TenantPool } from '../../common/tenant-pool.js';
import { applyTestMigrations } from '../apply-test-migrations.js';
import {
  SPIKE_ROLES,
  applySpikePolicies,
  createSpikeRoles,
  dropSpikeRoles,
} from './spike-policies.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the tenant pool suite would silently skip.',
  );
}

jest.setTimeout(300_000);

const DB = 'gg_tenant_pool';
const ROLES = SPIKE_ROLES.tests;

const ORGS = {
  A: '41000000-0000-4000-8000-00000000000a',
  B: '41000000-0000-4000-8000-00000000000b',
  C: '41000000-0000-4000-8000-00000000000c',
} as const;
type OrgKey = keyof typeof ORGS;
const ORG_KEYS: OrgKey[] = ['A', 'B', 'C'];

const userOf = (org: OrgKey) =>
  `41000000-0000-4000-8000-0000000001${org === 'A' ? '0a' : org === 'B' ? '0b' : '0c'}`;
/** Items per org: private, live public, trashed public. */
const itemOf = (org: OrgKey, kind: 'private' | 'public' | 'trashed') =>
  `41000000-0000-4000-8000-000000000${kind === 'private' ? '2' : kind === 'public' ? '3' : '4'}${org === 'A' ? '0a' : org === 'B' ? '0b' : '0c'}`;
const jobOf = (org: OrgKey) =>
  `41000000-0000-4000-8000-0000000005${org === 'A' ? '0a' : org === 'B' ? '0b' : '0c'}`;
const scopeOf = (org: OrgKey) => `data_layer:${itemOf(org, 'private')}:layer-1`;

const ALL_ITEMS = ORG_KEYS.flatMap((o) => [
  itemOf(o, 'private'),
  itemOf(o, 'public'),
  itemOf(o, 'trashed'),
]).sort();
const LIVE_PUBLIC = ORG_KEYS.map((o) => itemOf(o, 'public')).sort();
const visibleTo = (org: OrgKey) =>
  [
    ...new Set([
      itemOf(org, 'private'),
      itemOf(org, 'public'),
      itemOf(org, 'trashed'),
      ...LIVE_PUBLIC,
    ]),
  ].sort();

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

const rlsDenied = expect.objectContaining({
  message: expect.stringMatching(/row-level security/) as unknown,
}) as unknown;

d('tenant pool and row-level security trial', () => {
  const ownerUrl = TEST_URL ? databaseUrl(TEST_URL, DB) : '';
  let owner: Pool;
  let appUrl = '';
  let systemUrl = '';
  let pool: TenantPool;
  let prisma: PrismaClient;

  /** A fresh small TenantPool for tests that count connections. */
  const pools: Pool[] = [];
  function smallPool(max: number, options: { alwaysStamp?: boolean } = {}): TenantPool {
    const p = new TenantPool(
      { connectionString: appUrl, max },
      { systemPool: new Pool({ connectionString: systemUrl, max: 1 }), ...options },
    );
    pools.push(p);
    return p;
  }

  beforeAll(async () => {
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB}`);
    const logins = await createSpikeRoles(admin, TEST_URL!, DB, ROLES);
    await admin.end();
    appUrl = logins.appUrl;
    systemUrl = logins.systemUrl;
    applyTestMigrations(ownerUrl, join(__dirname, '../../../prisma/migrations'));

    owner = new Pool({ connectionString: ownerUrl, max: 2 });
    for (const o of ORG_KEYS) {
      await owner.query('INSERT INTO organization (id, slug, name) VALUES ($1, $2, $2)', [
        ORGS[o],
        `tp-${o.toLowerCase()}`,
      ]);
      await owner.query(
        `INSERT INTO "user" (id, org_id, username, email, full_name, org_role)
         VALUES ($1, $2, $3, $3 || '@example.test', $3, 'admin')`,
        [userOf(o), ORGS[o], `tp-user-${o.toLowerCase()}`],
      );
      for (const kind of ['private', 'public', 'trashed'] as const) {
        await owner.query(
          `INSERT INTO item (id, org_id, owner_id, type, title, data_json, access, deleted_at, updated_at)
           VALUES ($1, $2, $3, 'map', $4, '{}'::jsonb, $5::"ItemAccess", $6, now())`,
          [
            itemOf(o, kind),
            ORGS[o],
            userOf(o),
            `${o} ${kind}`,
            kind === 'private' ? 'private' : 'public',
            kind === 'trashed' ? new Date() : null,
          ],
        );
      }
      await owner.query(
        `INSERT INTO import_job (id, item_id, layer_id, staging_id, source_file_name,
           source_layer_name, mode, created_by, org_id)
         VALUES ($1, $2, 'layer-1', 'staging', 'f.geojson', 'f', 'append', $3, $4)`,
        [jobOf(o), itemOf(o, 'private'), userOf(o), ORGS[o]],
      );
      await owner.query(
        `INSERT INTO observation (id, valid_from, scope, entity, kind, author_sub, source)
         VALUES (gen_random_uuid(), now(), $1, gen_random_uuid(), 'create', 'seed', '{}'::jsonb)`,
        [scopeOf(o)],
      );
    }
    await applySpikePolicies(owner, ROLES);

    pool = new TenantPool(
      { connectionString: appUrl, max: 3 },
      { systemPool: new Pool({ connectionString: systemUrl, max: 2 }) },
    );
    prisma = new PrismaClient({
      adapter: new PrismaPg(pool),
      transactionOptions: { maxWait: 120_000, timeout: 120_000 },
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    if (pool && !pool.ended) await pool.end();
    for (const p of pools) if (!p.ended) await p.end();
    await owner?.end();
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await dropSpikeRoles(admin, ROLES);
    await admin.end();
  });

  const jobOrgs = (rows: Array<{ orgId?: string; org_id?: string }>): string[] =>
    rows.map((r) => r.orgId ?? r.org_id ?? '').sort();
  const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

  describe('roles', () => {
    it('the app role is not superuser, has no BYPASSRLS and owns no table', async () => {
      const { rows } = await owner.query(
        `SELECT r.rolsuper, r.rolbypassrls,
                (SELECT count(*)::int FROM pg_class c WHERE c.relowner = r.oid) AS owned
         FROM pg_roles r WHERE r.rolname = $1`,
        [ROLES.app],
      );
      expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false, owned: 0 }]);
    });
  });

  describe('policies, by direct SQL as the app role', () => {
    it('a connection with no stamp sees zero rows', async () => {
      // A plain client, as the LISTEN and leader-election clients are.
      const client = new Client({ connectionString: appUrl });
      await client.connect();
      try {
        for (const table of ['import_job', 'item']) {
          const { rows } = await client.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM ${table}`,
          );
          expect({ table, n: rows[0]!.n }).toEqual({ table, n: 0 });
        }
        // LISTEN still works on such a client.
        await client.query('LISTEN gg_tenant_pool_probe');
      } finally {
        await client.end();
      }
    });

    it('a checkout with no context stamps none and sees zero rows', async () => {
      const { rows } = await pool.query<{ n: number; ctx: string }>(
        `SELECT (SELECT count(*)::int FROM import_job) + (SELECT count(*)::int FROM item) AS n,
                current_setting('gratis.ctx') AS ctx`,
      );
      expect(rows).toEqual([{ n: 0, ctx: 'none' }]);
    });

    it('org B cannot select, update or delete org A rows by key', async () => {
      await runAsOrg(ORGS.B, async () => {
        const job = await pool.query('SELECT id FROM import_job WHERE id = $1', [jobOf('A')]);
        expect(job.rowCount).toBe(0);
        const upd = await pool.query("UPDATE import_job SET status = 'failed' WHERE id = $1", [
          jobOf('A'),
        ]);
        expect(upd.rowCount).toBe(0);
        const del = await pool.query('DELETE FROM import_job WHERE id = $1', [jobOf('A')]);
        expect(del.rowCount).toBe(0);

        const priv = await pool.query('SELECT id FROM item WHERE id = $1', [
          itemOf('A', 'private'),
        ]);
        expect(priv.rowCount).toBe(0);
        // A live public item is readable by id, by design, but not writable.
        const pub = await pool.query('SELECT id FROM item WHERE id = $1', [itemOf('A', 'public')]);
        expect(pub.rowCount).toBe(1);
        for (const id of [itemOf('A', 'private'), itemOf('A', 'public')]) {
          const u = await pool.query("UPDATE item SET title = 'taken' WHERE id = $1", [id]);
          expect(u.rowCount).toBe(0);
          const x = await pool.query('DELETE FROM item WHERE id = $1', [id]);
          expect(x.rowCount).toBe(0);
        }
        // Moving its own row to org A is refused too.
        await expect(
          pool.query('UPDATE import_job SET org_id = $1 WHERE id = $2', [ORGS.A, jobOf('B')]),
        ).rejects.toEqual(rlsDenied);
      });
      const still = await owner.query<{ status: string }>(
        'SELECT status::text AS status FROM import_job WHERE id = $1',
        [jobOf('A')],
      );
      expect(still.rows).toEqual([{ status: 'queued' }]);
      const titles = await owner.query<{ title: string }>(
        'SELECT title FROM item WHERE id = ANY($1::uuid[]) ORDER BY title',
        [[itemOf('A', 'private'), itemOf('A', 'public')]],
      );
      expect(titles.rows.map((r) => r.title)).toEqual(['A private', 'A public']);
    });

    it("inserting a row with org A's id is rejected for org B", async () => {
      await runAsOrg(ORGS.B, async () => {
        await expect(
          pool.query(
            `INSERT INTO import_job (item_id, layer_id, staging_id, source_file_name,
               source_layer_name, mode, created_by, org_id)
             VALUES ($1, 'l', 's', 'f', 'f', 'append', $2, $3)`,
            [itemOf('A', 'private'), userOf('A'), ORGS.A],
          ),
        ).rejects.toEqual(rlsDenied);
        await expect(
          pool.query(
            `INSERT INTO item (id, org_id, owner_id, type, title, data_json, updated_at)
             VALUES (gen_random_uuid(), $1, $2, 'map', 'x', '{}'::jsonb, now())`,
            [ORGS.A, userOf('A')],
          ),
        ).rejects.toEqual(rlsDenied);
      });
    });

    it('anonymous context sees only live public items and nothing else', async () => {
      await runAsAnonymous(async () => {
        const items = await pool.query<{ id: string }>('SELECT id FROM item');
        expect(ids(items.rows)).toEqual(LIVE_PUBLIC);
        const jobs = await pool.query('SELECT id FROM import_job');
        expect(jobs.rowCount).toBe(0);
        await expect(
          pool.query(
            `INSERT INTO item (id, org_id, owner_id, type, title, data_json, updated_at)
             VALUES (gen_random_uuid(), $1, $2, 'map', 'x', '{}'::jsonb, now())`,
            [ORGS.A, userOf('A')],
          ),
        ).rejects.toEqual(rlsDenied);
      });
    });

    it('the system role sees everything', async () => {
      await runAsSystem('test:rls-trial', async () => {
        const items = await pool.query<{ id: string }>('SELECT id FROM item');
        expect(ids(items.rows)).toEqual(ALL_ITEMS);
        const jobs = await pool.query<{ org_id: string }>('SELECT org_id FROM import_job');
        expect(jobOrgs(jobs.rows)).toEqual(Object.values(ORGS).sort());
        const who = await pool.query<{ u: string }>('SELECT current_user AS u');
        expect(who.rows[0]!.u).toBe(ROLES.system);
      });
    });

    it('observation, writes only: every org reads every layer, writes only its own', async () => {
      await runAsOrg(ORGS.B, async () => {
        const read = await pool.query('SELECT 1 FROM observation WHERE scope = $1', [scopeOf('A')]);
        expect(read.rowCount).toBe(1);
        await expect(
          pool.query(
            `INSERT INTO observation (id, valid_from, scope, entity, kind, author_sub, source)
             VALUES (gen_random_uuid(), now(), $1, gen_random_uuid(), 'create', 'b', '{}'::jsonb)`,
            [scopeOf('A')],
          ),
        ).rejects.toEqual(rlsDenied);
        const del = await pool.query('DELETE FROM observation WHERE scope = $1', [scopeOf('A')]);
        expect(del.rowCount).toBe(0);
        const upd = await pool.query("UPDATE observation SET author_sub = 'b' WHERE scope = $1", [
          scopeOf('A'),
        ]);
        expect(upd.rowCount).toBe(0);
        // A scope that is not a data layer of a known item is refused.
        await expect(
          pool.query(
            `INSERT INTO observation (id, valid_from, scope, entity, kind, author_sub, source)
             VALUES (gen_random_uuid(), now(), 'data_layer:not-a-uuid:x', gen_random_uuid(), 'create', 'b', '{}'::jsonb)`,
          ),
        ).rejects.toEqual(rlsDenied);
        // Its own layer works.
        const own = await pool.query(
          `INSERT INTO observation (id, valid_from, scope, entity, kind, author_sub, source)
           VALUES (gen_random_uuid(), now(), $1, gen_random_uuid(), 'create', 'b', '{}'::jsonb)`,
          [scopeOf('B')],
        );
        expect(own.rowCount).toBe(1);
      });
      await runAsAnonymous(async () => {
        await expect(
          pool.query(
            `INSERT INTO observation (id, valid_from, scope, entity, kind, author_sub, source)
             VALUES (gen_random_uuid(), now(), $1, gen_random_uuid(), 'create', 'x', '{}'::jsonb)`,
            [scopeOf('A')],
          ),
        ).rejects.toEqual(rlsDenied);
      });
      const a = await owner.query('SELECT 1 FROM observation WHERE scope = $1', [scopeOf('A')]);
      expect(a.rowCount).toBe(1);
    });
  });

  describe('every checkout path stamps the caller', () => {
    it('Prisma queries outside a transaction', async () => {
      const before = pool.counters.checkouts;
      const rows = await runAsOrg(
        ORGS.A,
        async () => await prisma.importJob.findMany({ select: { orgId: true } }),
      );
      expect(jobOrgs(rows)).toEqual([ORGS.A]);
      // The adapter used this pool, not one of its own.
      expect(pool.counters.checkouts).toBeGreaterThan(before);
    });

    it('Prisma interactive and array transactions, and concurrent queries in one request', async () => {
      await runAsOrg(ORGS.B, async () => {
        const [inTx, arr, ...parallel] = await Promise.all([
          prisma.$transaction(async (tx) => {
            const one = await tx.importJob.findMany({ select: { orgId: true } });
            const [two, three] = await Promise.all([
              tx.item.findMany({ select: { id: true } }),
              tx.$queryRaw<Array<{ org_id: string }>>`SELECT org_id::text FROM import_job`,
            ]);
            return { one, two, three };
          }),
          prisma.$transaction([
            prisma.importJob.findMany({ select: { orgId: true } }),
            prisma.item.findMany({ select: { id: true } }),
          ]),
          ...Array.from({ length: 6 }, () => prisma.item.findMany({ select: { id: true } })),
        ]);
        expect(jobOrgs(inTx.one)).toEqual([ORGS.B]);
        expect(ids(inTx.two)).toEqual(visibleTo('B'));
        expect(jobOrgs(inTx.three)).toEqual([ORGS.B]);
        expect(jobOrgs(arr[0])).toEqual([ORGS.B]);
        expect(ids(arr[1])).toEqual(visibleTo('B'));
        for (const p of parallel) expect(ids(p)).toEqual(visibleTo('B'));
      });
    });

    it('direct pool use: query, connect (promise) and connect (callback)', async () => {
      await runAsOrg(ORGS.C, async () => {
        const q = await pool.query<{ org_id: string }>('SELECT org_id FROM import_job');
        expect(jobOrgs(q.rows)).toEqual([ORGS.C]);
        const client = await pool.connect();
        try {
          const r = await client.query<{ org_id: string }>('SELECT org_id FROM import_job');
          expect(jobOrgs(r.rows)).toEqual([ORGS.C]);
        } finally {
          client.release();
        }
        const viaCallback = await new Promise<string[]>((resolve, reject) => {
          pool.connect((err, c, done) => {
            if (err || !c) return reject(err ?? new Error('no client'));
            c.query<{ org_id: string }>('SELECT org_id FROM import_job').then(
              (r) => {
                done();
                resolve(jobOrgs(r.rows));
              },
              (e: unknown) => {
                done(e);
                reject(e instanceof Error ? e : new Error(String(e)));
              },
            );
          });
        });
        expect(viaCallback).toEqual([ORGS.C]);
      });
    });

    it('a connection taken under one org and used later under another keeps the first', async () => {
      const client = await runAsOrg(ORGS.A, () => pool.connect());
      try {
        const later = await runAsOrg(ORGS.B, () =>
          client.query<{ org_id: string }>('SELECT org_id FROM import_job'),
        );
        expect(jobOrgs(later.rows)).toEqual([ORGS.A]);
      } finally {
        client.release();
      }
    });

    it('COPY FROM is refused on a table with row-level security, even into its own layer', async () => {
      const line = (scope: string) =>
        `${randomUUID()}\t2026-01-01 00:00:00+00\t${scope}\t${randomUUID()}\tcreate\tcopy\t{}\n`;
      const copySql =
        'COPY observation (id, valid_from, scope, entity, kind, author_sub, source) FROM STDIN WITH (FORMAT text)';
      const copyInto = async (client: PoolClient, scope: string) => {
        await client.query('BEGIN');
        try {
          await pipeline(
            Readable.from([line(scope), line(scope)]),
            client.query(copyFrom(copySql)),
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      };
      // PostgreSQL does not support COPY FROM into a table whose
      // policies apply to the current role. The import path's COPY
      // would fail as soon as observation has any policy.
      const app = await runAsOrg(ORGS.A, () => pool.connect());
      try {
        await expect(copyInto(app, scopeOf('A'))).rejects.toThrow(
          /COPY FROM not supported with row-level security/,
        );
      } finally {
        app.release();
      }
      // The system login is exempt, so a COPY there works.
      const sys = await runAsSystem('test:copy', () => pool.connect());
      try {
        await copyInto(sys, scopeOf('A'));
      } finally {
        sys.release();
      }
      const counts = await owner.query<{ scope: string; n: number }>(
        `SELECT scope, count(*)::int AS n FROM observation WHERE author_sub = 'copy' GROUP BY scope`,
      );
      expect(counts.rows).toEqual([{ scope: scopeOf('A'), n: 2 }]);
    });
  });

  describe('context changes while a connection is held', () => {
    it('runAsSystem inside an org transaction still sees one org; outside it, the system pool', async () => {
      const result = await runAsOrg(
        ORGS.A,
        async () =>
          await prisma.$transaction(async (tx) => {
            const insideTx = await runAsSystem('test:in-tx', () =>
              tx.importJob.findMany({ select: { orgId: true } }),
            );
            const otherOrgInTx = await runAsOrg(ORGS.B, () =>
              tx.importJob.findMany({ select: { orgId: true } }),
            );
            const outsideTx = await runAsSystem(
              'test:no-tx',
              async () => await prisma.importJob.findMany({ select: { orgId: true } }),
            );
            return { insideTx, otherOrgInTx, outsideTx };
          }),
      );
      expect(jobOrgs(result.insideTx)).toEqual([ORGS.A]);
      expect(jobOrgs(result.otherOrgInTx)).toEqual([ORGS.A]);
      expect(jobOrgs(result.outsideTx)).toEqual(Object.values(ORGS).sort());
    });

    it('a system transaction started inside runAsSystem sees everything', async () => {
      const rows = await runAsOrg(ORGS.A, () =>
        runAsSystem(
          'test:sys-tx',
          async () =>
            await prisma.$transaction(async (tx) =>
              tx.importJob.findMany({ select: { orgId: true } }),
            ),
        ),
      );
      expect(jobOrgs(rows)).toEqual(Object.values(ORGS).sort());
    });

    it('a Prisma call returned unstarted from runAsOrg runs in the OUTER context', async () => {
      // Prisma queries are lazy: they start when awaited, not when
      // called. Here the inner function returns the query unstarted,
      // runAsOrg ends, and the await outside starts it as system work.
      const lazy = await runAsSystem(
        'test:outer',
        async () =>
          await runAsOrg(ORGS.B, () => prisma.importJob.findMany({ select: { orgId: true } })),
      );
      expect(jobOrgs(lazy)).toEqual(Object.values(ORGS).sort());
      // Awaited inside, it runs as org B.
      const awaited = await runAsSystem(
        'test:outer',
        async () =>
          await runAsOrg(
            ORGS.B,
            async () => await prisma.importJob.findMany({ select: { orgId: true } }),
          ),
      );
      expect(jobOrgs(awaited)).toEqual([ORGS.B]);
    });
  });

  describe('errors, aborts and reuse', () => {
    it('a failed query outside a transaction destroys its connection; the next one is stamped', async () => {
      const p = smallPool(1);
      await runAsOrg(ORGS.A, () => p.query('SELECT 1'));
      await runAsOrg(ORGS.A, async () => {
        await expect(p.query('SELECT * FROM no_such_table')).rejects.toThrow(/no_such_table/);
      });
      // pg-pool destroys a connection whose query failed through pool.query.
      expect(p.totalCount).toBe(0);
      const rows = await runAsOrg(ORGS.B, () =>
        p.query<{ org_id: string }>('SELECT org_id FROM import_job'),
      );
      expect(jobOrgs(rows.rows)).toEqual([ORGS.B]);
    });

    it('a statement cancelled inside a Prisma transaction rolls back and the connection stays correct', async () => {
      const p = smallPool(1);
      const client = new PrismaClient({ adapter: new PrismaPg(p) });
      try {
        await runAsOrg(ORGS.A, async () => {
          await expect(
            client.$transaction(async (tx) => {
              await tx.$executeRaw`SET LOCAL statement_timeout = 50`;
              await tx.$queryRaw`SELECT pg_sleep(2)`;
            }),
          ).rejects.toThrow(/statement timeout|canceling statement/);
        });
        // Same single connection, reused: still stamped for A.
        const a = await runAsOrg(
          ORGS.A,
          async () => await client.importJob.findMany({ select: { orgId: true } }),
        );
        expect(jobOrgs(a)).toEqual([ORGS.A]);
        const b = await runAsOrg(
          ORGS.B,
          async () => await client.importJob.findMany({ select: { orgId: true } }),
        );
        expect(jobOrgs(b)).toEqual([ORGS.B]);
        expect(p.counters.dirty).toBe(0);
      } finally {
        await client.$disconnect();
      }
    });

    it('a connection returned inside a transaction is destroyed, never reused', async () => {
      const p = smallPool(1);
      const leaked = await runAsOrg(ORGS.A, () => p.connect());
      await leaked.query('BEGIN');
      leaked.release(); // a bug: back to the pool with the transaction open
      const rows = await runAsOrg(ORGS.B, async () => {
        const c = await p.connect();
        try {
          const r = await c.query<{ org_id: string }>('SELECT org_id FROM import_job');
          // If this were the leaked connection, a ROLLBACK now would undo
          // the B stamp and bring back A's.
          await c.query('ROLLBACK');
          const again = await c.query<{ org_id: string }>('SELECT org_id FROM import_job');
          return [...r.rows, ...again.rows];
        } finally {
          c.release();
        }
      });
      expect(jobOrgs(rows)).toEqual([ORGS.B, ORGS.B]);
      expect(p.counters.dirty).toBe(1);
    });

    it('why: a stamp written inside a transaction is undone by ROLLBACK', async () => {
      const c = new Client({ connectionString: appUrl });
      await c.connect();
      try {
        await c.query("SELECT set_config('gratis.org_id', $1, false)", [ORGS.A]);
        await c.query('BEGIN');
        await c.query("SELECT set_config('gratis.org_id', $1, false)", [ORGS.B]);
        await c.query('ROLLBACK');
        const r = await c.query<{ v: string }>("SELECT current_setting('gratis.org_id') AS v");
        expect(r.rows[0]!.v).toBe(ORGS.A);
      } finally {
        await c.end();
      }
    });

    it('a failed stamp destroys the connection and fails the checkout; the pool recovers', async () => {
      const p = smallPool(1);
      const first = await runAsOrg(ORGS.A, () => p.connect());
      // Make the next statement on this exact connection fail once.
      const original = first.query.bind(first) as (...args: unknown[]) => unknown;
      let failNext = true;
      (first as unknown as { query: (...args: unknown[]) => unknown }).query = (
        ...args: unknown[]
      ) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error('stamp failed on purpose'));
        }
        return original(...args);
      };
      first.release();
      await runAsOrg(ORGS.B, async () => {
        await expect(p.query('SELECT 1')).rejects.toThrow('stamp failed on purpose');
      });
      expect(p.counters.failed).toBe(1);
      expect(p.totalCount).toBe(0);
      const rows = await runAsOrg(ORGS.B, () =>
        p.query<{ org_id: string }>('SELECT org_id FROM import_job'),
      );
      expect(jobOrgs(rows.rows)).toEqual([ORGS.B]);
    });

    it('a context with a non-UUID org id fails the checkout instead of stamping', async () => {
      await runAsOrg('not-a-uuid', async () => {
        await expect(pool.query('SELECT 1')).rejects.toThrow(/not a UUID/);
      });
    });

    it('a setting changed by hand survives a same-org checkout unless alwaysStamp is on', async () => {
      const run = async (p: TenantPool) => {
        await runAsOrg(ORGS.A, async () => {
          const c = await p.connect();
          // Code that writes the setting itself, as injected SQL could.
          await c.query("SELECT set_config('gratis.org_id', $1, false)", [ORGS.B]);
          c.release();
        });
        const r = await runAsOrg(ORGS.A, () =>
          p.query<{ org_id: string }>('SELECT org_id FROM import_job'),
        );
        return jobOrgs(r.rows);
      };
      expect(await run(smallPool(1))).toEqual([ORGS.B]);
      expect(await run(smallPool(1, { alwaysStamp: true }))).toEqual([ORGS.A]);
    });
  });

  describe("Prisma request batching runs queries in another request's context", () => {
    // Prisma queues findUnique (outside an interactive transaction) and
    // the array form of $transaction, then runs everything queued in
    // one tick from a single process.nextTick. That callback carries
    // the async context of the request that queued first, so every
    // query in the tick is stamped for that request.

    it("findUnique: org B, queued after a system request, reads org A's row", async () => {
      const [sys, b] = await Promise.all([
        runAsSystem(
          'test:batch',
          async () => await prisma.importJob.findUnique({ where: { id: jobOf('C') } }),
        ),
        runAsOrg(
          ORGS.B,
          async () => await prisma.importJob.findUnique({ where: { id: jobOf('A') } }),
        ),
      ]);
      expect(sys?.orgId).toBe(ORGS.C);
      // The database lock did not hold for B: it ran on the system login.
      expect(b?.orgId).toBe(ORGS.A);
    });

    it('findUnique: org B, queued after org A, does not find its own row', async () => {
      const [a, b] = await Promise.all([
        runAsOrg(
          ORGS.A,
          async () => await prisma.importJob.findUnique({ where: { id: jobOf('A') } }),
        ),
        runAsOrg(
          ORGS.B,
          async () => await prisma.importJob.findUnique({ where: { id: jobOf('B') } }),
        ),
      ]);
      expect(a?.orgId).toBe(ORGS.A);
      expect(b).toBeNull();
    });

    it("array $transaction: org B, queued after org A, sees org A's rows", async () => {
      const [a, b] = await Promise.all([
        runAsOrg(
          ORGS.A,
          async () =>
            await prisma.$transaction([prisma.importJob.findMany({ select: { orgId: true } })]),
        ),
        runAsOrg(
          ORGS.B,
          async () =>
            await prisma.$transaction([prisma.importJob.findMany({ select: { orgId: true } })]),
        ),
      ]);
      expect(jobOrgs(a[0])).toEqual([ORGS.A]);
      expect(jobOrgs(b[0])).toEqual([ORGS.A]);
    });

    it('findFirst and interactive transactions are not batched and stay correct', async () => {
      const [sys, b, bTx] = await Promise.all([
        runAsSystem(
          'test:batch',
          async () => await prisma.importJob.findFirst({ where: { id: jobOf('C') } }),
        ),
        runAsOrg(
          ORGS.B,
          async () => await prisma.importJob.findFirst({ where: { id: jobOf('A') } }),
        ),
        runAsOrg(
          ORGS.B,
          async () =>
            await prisma.$transaction(async (tx) =>
              tx.importJob.findUnique({ where: { id: jobOf('A') } }),
            ),
        ),
      ]);
      expect(sys?.orgId).toBe(ORGS.C);
      expect(b).toBeNull();
      expect(bTx).toBeNull();
    });
  });

  describe('a stamp never survives onto the next checkout', () => {
    type Who = OrgKey | 'anon' | 'none' | 'system';
    const WHO: Who[] = ['A', 'B', 'C', 'anon', 'none', 'B', 'A', 'system', 'C'];

    function expected(who: Who): { jobs: string[]; items: string[] } {
      switch (who) {
        case 'anon':
          return { jobs: [], items: LIVE_PUBLIC };
        case 'none':
          return { jobs: [], items: [] };
        case 'system':
          return { jobs: Object.values(ORGS).sort(), items: ALL_ITEMS };
        default:
          return { jobs: [ORGS[who]], items: visibleTo(who) };
      }
    }

    function within<T>(who: Who, fn: () => Promise<T>): Promise<T> {
      switch (who) {
        case 'anon':
          return runAsAnonymous(fn);
        case 'none':
          return fn();
        case 'system':
          return runAsSystem('test:hammer', fn);
        default:
          return runAsOrg(ORGS[who], fn, { userId: userOf(who) });
      }
    }

    /** One "request": a few queries by one of several paths. */
    async function request(path: number): Promise<{ jobs: string[]; items: string[] }> {
      switch (path) {
        case 0: {
          const [j, i] = await Promise.all([
            prisma.importJob.findMany({ select: { orgId: true } }),
            prisma.item.findMany({ select: { id: true } }),
          ]);
          return { jobs: jobOrgs(j), items: ids(i) };
        }
        case 1: {
          // By-id reads as findFirst, which Prisma does not batch.
          const found = await Promise.all(
            ALL_ITEMS.map((id) => prisma.item.findFirst({ where: { id }, select: { id: true } })),
          );
          const j = await prisma.importJob.findMany({ select: { orgId: true } });
          return {
            jobs: jobOrgs(j),
            items: ids(found.filter((r): r is { id: string } => r !== null)),
          };
        }
        case 2:
          return prisma.$transaction(async (tx) => {
            const j = await tx.importJob.findMany({ select: { orgId: true } });
            await tx.$executeRaw`SELECT pg_sleep(0.001)`;
            // findUnique inside an interactive transaction is batched
            // too, but always runs on the transaction's own connection.
            const found = await Promise.all(
              ALL_ITEMS.map((id) => tx.item.findUnique({ where: { id }, select: { id: true } })),
            );
            return {
              jobs: jobOrgs(j),
              items: ids(found.filter((r): r is { id: string } => r !== null)),
            };
          });
        case 3: {
          const j = await prisma.$queryRaw<
            Array<{ org_id: string }>
          >`SELECT org_id::text FROM import_job`;
          const i = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id::text FROM item`;
          return { jobs: jobOrgs(j), items: ids(i) };
        }
        case 4: {
          const [j, i] = await Promise.all([
            pool.query<{ org_id: string }>('SELECT org_id FROM import_job'),
            pool.query<{ id: string }>('SELECT id FROM item'),
          ]);
          return { jobs: jobOrgs(j.rows), items: ids(i.rows) };
        }
        default: {
          const c = await pool.connect();
          try {
            const j = await c.query<{ org_id: string }>('SELECT org_id FROM import_job');
            await new Promise((r) => setImmediate(r));
            const i = await c.query<{ id: string }>('SELECT id FROM item');
            return { jobs: jobOrgs(j.rows), items: ids(i.rows) };
          } finally {
            c.release();
          }
        }
      }
    }

    it('thousands of concurrent requests, alternating orgs, on a small pool', async () => {
      const ROUNDS = 12;
      const PER_ROUND = 250;
      let checked = 0;
      const mismatches: string[] = [];
      for (let round = 0; round < ROUNDS; round += 1) {
        await Promise.all(
          Array.from({ length: PER_ROUND }, async (_, n) => {
            const k = round * PER_ROUND + n;
            const who = WHO[k % WHO.length]!;
            const path = (k * 7 + round) % 6;
            const got = await within(who, () => request(path));
            const want = expected(who);
            checked += 1;
            if (JSON.stringify(got) !== JSON.stringify(want)) {
              mismatches.push(`request ${k} as ${who} by path ${path}: ${JSON.stringify(got)}`);
            }
          }),
        );
      }
      expect(mismatches).toEqual([]);
      expect(checked).toBe(ROUNDS * PER_ROUND);
      // The pool really did hand connections from one org to another.
      expect(pool.counters.stamped).toBeGreaterThan(1000);
    });
  });
});
