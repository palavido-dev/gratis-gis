// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Measurements for the row-level security trial. Skipped unless
// TENANT_POOL_MEASURE=1 and TEST_DATABASE_URL are both set: it seeds a
// few hundred thousand rows and takes minutes. Results are written as
// JSON to TENANT_POOL_MEASURE_OUT.
//
// Sizes: MEASURE_ITEMS (default 200000), MEASURE_ROWS (default
// 1000000), MEASURE_REPEATS (default 2), MEASURE_STAMP_ITER (default
// 2000).

import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Writable } from 'node:stream';

import { PrismaPg } from '@prisma/adapter-pg';
import { type Prisma, PrismaClient } from '@prisma/client';
import { Pool, type PoolClient } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';

import type { AuthUser } from '../../auth/auth-sync.service.js';
import { runAsAnonymous, runAsOrg } from '../../common/tenant-context.js';
import { TenantPool } from '../../common/tenant-pool.js';
import { resetTenancyModeForTests } from '../../common/tenancy.js';
import { SharingService } from '../../items/sharing.service.js';
import { applyTestMigrations } from '../apply-test-migrations.js';
import {
  HELPER_FUNCTIONS_SQL,
  ITEM_POLICY_SQL,
  OBSERVATION_NO_POLICY_SQL,
  OBSERVATION_WRITES_ONLY_SQL,
  ORG_TABLE_POLICY_SQL,
  SPIKE_ROLES,
  createSpikeRoles,
  dropSpikeRoles,
  grantsSql,
} from './spike-policies.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const ON = process.env.TENANT_POOL_MEASURE === '1' && Boolean(TEST_URL);
const d = ON ? describe : describe.skip;

const DB = 'gg_rls_measure';
const ROLES = SPIKE_ROLES.bench;
const ITEMS = Number(process.env.MEASURE_ITEMS ?? 200_000);
const ROWS = Number(process.env.MEASURE_ROWS ?? 1_000_000);
const REPEATS = Number(process.env.MEASURE_REPEATS ?? 2);
const STAMP_ITER = Number(process.env.MEASURE_STAMP_ITER ?? 2000);
const ORG_COUNT = 50;

jest.setTimeout(3_600_000);

const orgId = (n: number) => `62000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const adminId = (n: number) => `63000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const memberId = (n: number) => `64000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const LAYER_ITEM = '65000000-0000-4000-8000-000000000001';
const SCOPE = `data_layer:${LAYER_ITEM}:parcels`;

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}
const round = (x: number, places = 3) => Number(x.toFixed(places));

type PlanNode = {
  'Node Type': string;
  'Index Name'?: string;
  'Relation Name'?: string;
  'Index Cond'?: string;
  Filter?: string;
  Plans?: PlanNode[];
};

/** "Index Scan item_pkey; Seq Scan item" style summary of a plan. */
function scans(node: PlanNode, out: string[] = []): string[] {
  const t = node['Node Type'];
  if (/Scan/.test(t)) {
    const cond = node['Index Cond'] ? ` [index: ${node['Index Cond']}]` : '';
    const filter = node.Filter ? ` [filter: ${node.Filter.slice(0, 160)}]` : '';
    out.push(`${t} ${node['Index Name'] ?? node['Relation Name'] ?? ''}${cond}${filter}`.trim());
  }
  for (const child of node.Plans ?? []) scans(child, out);
  return out;
}

const results: Record<string, unknown> = {
  when: new Date().toISOString(),
  sizes: { ITEMS, ROWS, REPEATS, STAMP_ITER, ORG_COUNT },
};

function save(): void {
  const out = process.env.TENANT_POOL_MEASURE_OUT;
  if (out) writeFileSync(out, JSON.stringify(results, null, 2));
}

d('row-level security measurements', () => {
  const ownerUrl = TEST_URL ? databaseUrl(TEST_URL, DB) : '';
  let owner: Pool;
  let appUrl = '';
  let systemUrl = '';

  beforeAll(async () => {
    process.env.GRATIS_TENANCY = 'multi';
    resetTenancyModeForTests();
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB}`);
    const logins = await createSpikeRoles(admin, TEST_URL!, DB, ROLES);
    await admin.end();
    appUrl = logins.appUrl;
    systemUrl = logins.systemUrl;
    applyTestMigrations(ownerUrl, join(__dirname, '../../../prisma/migrations'));
    owner = new Pool({ connectionString: ownerUrl, max: 2 });
    // end() resolves before sockets close; the final DROP ... WITH
    // (FORCE) must not surface as an unhandled pool error.
    owner.on('error', () => undefined);
    const version = await owner.query<{ v: string; g: string }>(
      'SELECT version() AS v, postgis_lib_version() AS g',
    );
    results.server = version.rows[0];
    await seed(owner);
    await owner.query(HELPER_FUNCTIONS_SQL);
    await owner.query(grantsSql(ROLES));
    await owner.query(ORG_TABLE_POLICY_SQL);
    await owner.query(`GRANT TEMP ON DATABASE ${DB} TO ${ROLES.app}`);
  });

  afterAll(async () => {
    save();
    await owner?.end();
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await dropSpikeRoles(admin, ROLES);
    await admin.end();
    delete process.env.GRATIS_TENANCY;
    resetTenancyModeForTests();
  });

  async function seed(pool: Pool): Promise<void> {
    await pool.query(
      `INSERT INTO organization (id, slug, name)
       SELECT ('62000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid, 'm-org-' || g, 'Org ' || g
       FROM generate_series(1, $1::int) g`,
      [ORG_COUNT],
    );
    await pool.query(
      `INSERT INTO "user" (id, org_id, username, email, full_name, org_role)
       SELECT ('63000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
              ('62000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
              'm-admin-' || g, 'm-admin-' || g || '@example.test', 'Admin ' || g, 'admin'::"OrgRole"
       FROM generate_series(1, $1::int) g
       UNION ALL
       SELECT ('64000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
              ('62000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
              'm-member-' || g, 'm-member-' || g || '@example.test', 'Member ' || g, 'contributor'::"OrgRole"
       FROM generate_series(1, $1::int) g`,
      [ORG_COUNT],
    );
    // Items spread evenly over the orgs. Every 10th is public, two in
    // ten are org-wide, one in twenty is in the trash.
    await pool.query(
      `WITH words AS (
         SELECT ARRAY['river','parcel','survey','wetland','road','county','habitat','zoning','permit','trail'] AS w
       ), src AS (
         SELECT i, 1 + (i % $2::int) AS o,
                (ARRAY['map','data-layer','folder','form','file','dashboard','web-app','geo-boundary'])[1 + (i % 8)] AS t
         FROM generate_series(1, $1::int) i
       )
       INSERT INTO item (id, org_id, owner_id, type, title, description, tags, data_json,
                         access, bbox, deleted_at, created_at, updated_at, storage_ref)
       SELECT gen_random_uuid(),
              ('62000000-0000-4000-8000-' || lpad(to_hex(o), 12, '0'))::uuid,
              ('63000000-0000-4000-8000-' || lpad(to_hex(o), 12, '0'))::uuid,
              t::"ItemType",
              w[1 + (i * 7 % 10)] || ' ' || w[1 + (i * 13 % 10)] || ' ' || i,
              'Description of ' || w[1 + (i * 3 % 10)] || ' work item number ' || i || ' for the county planning office.',
              ARRAY[w[1 + (i % 10)], w[1 + (i * 3 % 10)]],
              CASE t
                WHEN 'folder' THEN jsonb_build_object('version', 1, 'childItemIds', jsonb_build_array(md5(i::text)))
                WHEN 'file' THEN jsonb_build_object('storageKey', 'orgs/' || o || '/files/' || i || '.bin')
                ELSE jsonb_build_object('version', 1)
              END,
              (CASE WHEN i % 10 = 0 THEN 'public' WHEN i % 10 IN (1, 2) THEN 'org' ELSE 'private' END)::"ItemAccess",
              CASE WHEN t IN ('map', 'data-layer', 'geo-boundary') THEN
                ARRAY[-120 + ((i * 37) % 4500) / 100.0, 25 + ((i * 53) % 2300) / 100.0,
                      -120 + ((i * 37) % 4500) / 100.0 + 0.05, 25 + ((i * 53) % 2300) / 100.0 + 0.05]::double precision[]
              ELSE '{}'::double precision[] END,
              CASE WHEN i % 20 = 7 THEN now() END,
              now() - (i || ' minutes')::interval,
              now() - (i || ' seconds')::interval,
              NULL
       FROM src, words`,
      [ITEMS, ORG_COUNT],
    );
    // A few shares to a member of the next org.
    await pool.query(
      `INSERT INTO item_share (item_id, principal_type, principal_id)
       SELECT id, 'user',
              ('64000000-0000-4000-8000-' || lpad(to_hex(((hashtext(id::text) & 2147483647) % $1::int) + 1), 12, '0'))::uuid
       FROM item WHERE (hashtext(id::text) % 100) = 0`,
      [ORG_COUNT],
    );
    await pool.query(
      `INSERT INTO item (id, org_id, owner_id, type, title, data_json, updated_at)
       VALUES ($1, $2, $3, 'data-layer', 'Import target', '{}'::jsonb, now())`,
      [LAYER_ITEM, orgId(7), adminId(7)],
    );
    await pool.query('VACUUM ANALYZE item');
    await pool.query('VACUUM ANALYZE item_share');
    const size = await pool.query<{ s: string }>(
      'SELECT pg_size_pretty(pg_total_relation_size($1::regclass)) AS s',
      ['item'],
    );
    results.itemTableSize = size.rows[0]!.s;
  }

  function fakeUser(n: number, role: 'admin' | 'contributor'): AuthUser {
    return {
      id: role === 'admin' ? adminId(n) : memberId(n),
      orgId: orgId(n),
      orgRole: role,
      groupIds: [],
    } as unknown as AuthUser;
  }

  /** The where clause ItemsService.list builds, from the real code. */
  function listWhere(user: AuthUser): Prisma.ItemWhereInput {
    const sharing = Object.create(SharingService.prototype) as SharingService;
    return sharing.listWhere(user);
  }

  type Captured = { sql: string; params: unknown[] };

  /** Run Prisma calls once as the owner and keep the SQL they send. */
  async function capture(run: (prisma: PrismaClient) => Promise<unknown>): Promise<Captured[]> {
    const pool = new Pool({ connectionString: ownerUrl, max: 1 });
    const prisma = new PrismaClient({
      adapter: new PrismaPg(pool),
      log: [{ emit: 'event', level: 'query' }],
    });
    const seen: Captured[] = [];
    prisma.$on('query' as never, (e: { query: string; params: string }) => {
      seen.push({ sql: e.query, params: JSON.parse(e.params) as unknown[] });
    });
    try {
      await run(prisma);
    } finally {
      await prisma.$disconnect();
    }
    return seen.filter((q) => /^\s*SELECT/i.test(q.sql));
  }

  async function explainOnce(
    client: PoolClient,
    q: Captured,
  ): Promise<{ ms: number; scans: string[]; rows: number }> {
    const r = await client.query<{
      'QUERY PLAN': Array<{ Plan: PlanNode & { 'Actual Rows': number }; 'Execution Time': number }>;
    }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.sql}`, q.params);
    const plan = r.rows[0]!['QUERY PLAN'][0]!;
    return { ms: plan['Execution Time'], scans: scans(plan.Plan), rows: plan.Plan['Actual Rows'] };
  }

  /** Two warm-ups, five timed runs, sum over the request's statements. */
  async function timeRequest(client: PoolClient, qs: Captured[]) {
    const totals: number[] = [];
    let last: Array<{ scans: string[]; rows: number }> = [];
    for (let i = 0; i < 7; i += 1) {
      let total = 0;
      const plans: Array<{ scans: string[]; rows: number }> = [];
      for (const q of qs) {
        const r = await explainOnce(client, q);
        total += r.ms;
        plans.push({ scans: r.scans, rows: r.rows });
      }
      if (i >= 2) totals.push(total);
      last = plans;
    }
    return { medianMs: round(median(totals), 2), plans: last };
  }

  it('item: index use and timings with and without the policy', async () => {
    const n = 7;
    const admin = fakeUser(n, 'admin');
    const member = fakeUser(n, 'contributor');
    const someItem = await owner.query<{ id: string }>(
      "SELECT id FROM item WHERE org_id = $1 AND type = 'map' AND deleted_at IS NULL LIMIT 1",
      [orgId(n)],
    );
    const fileKey = await owner.query<{ k: string }>(
      "SELECT data_json->>'storageKey' AS k FROM item WHERE org_id = $1 AND type = 'file' LIMIT 1",
      [orgId(n)],
    );
    const listSelect = {
      id: true,
      orgId: true,
      ownerId: true,
      type: true,
      title: true,
      description: true,
      tags: true,
      thumbnailUrl: true,
      thumbnailDesign: true,
      license: true,
      seedKind: true,
      storageRef: true,
      access: true,
      createdAt: true,
      updatedAt: true,
      deletedAt: true,
      bbox: true,
      bboxSrs: true,
      shares: true,
      owner: { select: { id: true, username: true, fullName: true, avatarUrl: true } },
    } as const;
    const searchWhere = (user: AuthUser, q: string): Prisma.ItemWhereInput => ({
      AND: [
        listWhere(user),
        {
          OR: [
            { title: { contains: q, mode: 'insensitive' } },
            { description: { contains: q, mode: 'insensitive' } },
            { tags: { has: q } },
          ],
        },
      ],
    });

    const requests: Record<string, Captured[]> = {
      'list, admin (findMany 500 + count)': await capture(async (p) => {
        const where = listWhere(admin);
        await p.item.findMany({
          where,
          select: listSelect,
          orderBy: { updatedAt: 'desc' },
          take: 500,
        });
        await p.item.count({ where });
      }),
      'list, member (findMany 500 + count)': await capture(async (p) => {
        const where = listWhere(member);
        await p.item.findMany({
          where,
          select: listSelect,
          orderBy: { updatedAt: 'desc' },
          take: 500,
        });
        await p.item.count({ where });
      }),
      'search "wetland", admin (ILIKE title/description, tags has)': await capture(async (p) => {
        const where = searchWhere(admin, 'wetland');
        await p.item.findMany({
          where,
          select: listSelect,
          orderBy: { updatedAt: 'desc' },
          take: 500,
        });
        await p.item.count({ where });
      }),
      'get by id (findUnique with shares and owner)': await capture(async (p) => {
        await p.item.findUnique({
          where: { id: someItem.rows[0]!.id },
          include: {
            shares: true,
            owner: { select: { id: true, username: true, fullName: true, avatarUrl: true } },
          },
        });
      }),
      'public list of one org (anonymous)': await capture(async (p) => {
        await p.item.findMany({
          where: { orgId: orgId(n), access: 'public', deletedAt: null },
          orderBy: { updatedAt: 'desc' },
          take: 100,
          select: { id: true, title: true, type: true, updatedAt: true },
        });
      }),
    };
    // Raw SQL copied from the code.
    requests['area search pre-filter (items.service buildListWhere, bbox_geom &&)'] = [
      {
        sql: `SELECT id FROM "item"
        WHERE "bbox_geom" IS NOT NULL
          AND "deleted_at" IS NULL
          AND "type" IN ('map', 'data-layer', 'arcgis-service', 'wms-service', 'wfs-service', 'geo-boundary')
          AND ("org_id" = $1::uuid OR "access" = 'public'
               OR EXISTS (SELECT 1 FROM "item_share" s WHERE s."item_id" = "item"."id"))
          AND ("bbox_geom" && ST_MakeEnvelope($2, $3, $4, $5, 4326))`,
        params: [orgId(n), -100, 35, -98, 37],
      },
    ];
    requests['owner of a storage key (storage.controller findItemIdOwningKey, data_json @>)'] = [
      {
        sql: `SELECT id FROM "item"
    WHERE deleted_at IS NULL
      AND (
        storage_ref = $1
        OR data_json @> jsonb_build_object('storageKey', $2::text)
        OR data_json @> jsonb_build_object('pmtilesStorageKey', $3::text)
        OR data_json @> jsonb_build_object('cogStorageKey', $4::text)
      )
    ORDER BY created_at ASC
    LIMIT 1`,
        params: Array(4).fill(fileKey.rows[0]!.k) as string[],
      },
    ];
    // Shapes the app could add, to show which predicate kinds keep an
    // index under the policy. Title has no trigram index today; one is
    // added for this run only.
    requests['shape: title ILIKE with a trigram index (none exists today)'] = [
      { sql: `SELECT id FROM item WHERE title ILIKE $1 LIMIT 50`, params: ['%wetland road 123%'] },
    ];
    requests['shape: title LIKE prefix with a text_pattern_ops index (none exists today)'] = [
      { sql: `SELECT id FROM item WHERE title LIKE $1 LIMIT 50`, params: ['wetland road 123%'] },
    ];
    requests['fix: area pre-filter limited to own org (org_id = $1 AND ...)'] = [
      {
        sql: `SELECT id FROM "item"
        WHERE "org_id" = $1::uuid AND "bbox_geom" IS NOT NULL AND "deleted_at" IS NULL
          AND ("bbox_geom" && ST_MakeEnvelope($2, $3, $4, $5, 4326))`,
        params: [orgId(n), -100, 35, -98, 37],
      },
    ];
    results.itemSql = Object.fromEntries(
      Object.entries(requests).map(([k, qs]) => [k, qs.map((q) => q.sql.replace(/\s+/g, ' '))]),
    );

    const variants: Array<{ name: string; setup: string; teardown: string; app: boolean }> = [
      { name: 'owner, no policy (today)', setup: '', teardown: '', app: false },
      { name: 'app role, item policy', setup: ITEM_POLICY_SQL, teardown: '', app: true },
      {
        name: 'app role, item policy + partial index on live public items',
        setup: `CREATE INDEX IF NOT EXISTS item_public_live_measure ON item (org_id) WHERE access = 'public' AND deleted_at IS NULL; ANALYZE item;`,
        teardown: `DROP INDEX IF EXISTS item_public_live_measure;`,
        app: true,
      },
    ];
    await owner.query(
      `CREATE INDEX item_title_trgm_measure ON item USING gin (title gin_trgm_ops);
       CREATE INDEX item_title_pattern_measure ON item (title text_pattern_ops);
       ANALYZE item;`,
    );
    const table: Array<Record<string, unknown>> = [];
    for (const v of variants) {
      if (v.setup) await owner.query(v.setup);
      const pool = v.app
        ? new TenantPool(
            { connectionString: appUrl, max: 1 },
            {
              systemPool: new Pool({ connectionString: systemUrl, max: 1 }),
            },
          )
        : new Pool({ connectionString: ownerUrl, max: 1 });
      try {
        for (const [name, qs] of Object.entries(requests)) {
          const anon = name.includes('anonymous');
          const run = async () => {
            const client = await pool.connect();
            try {
              return await timeRequest(client, qs);
            } finally {
              client.release();
            }
          };
          const r = anon
            ? await runAsAnonymous(run)
            : await runAsOrg(orgId(n), run, { userId: adminId(n) });
          table.push({ query: name, variant: v.name, ...r });
        }
      } finally {
        await pool.end();
      }
      if (v.teardown) await owner.query(v.teardown);
    }
    await owner.query('DROP INDEX item_title_trgm_measure; DROP INDEX item_title_pattern_measure;');
    results.item = table;
    save();
  });

  it('stamp cost per checkout', async () => {
    await owner.query(ITEM_POLICY_SQL).catch(() => undefined);
    const n = 7;
    const where = listWhere(fakeUser(n, 'admin'));
    const make = (kind: 'owner' | 'app-fixed' | 'tenant' | 'tenant-always'): Pool => {
      if (kind === 'owner') return new Pool({ connectionString: ownerUrl, max: 1 });
      if (kind === 'app-fixed') {
        // The org is set once at login, so this pays the policy but
        // never the stamp.
        return new Pool({
          connectionString: appUrl,
          max: 1,
          options: `-c gratis.org_id=${orgId(n)} -c gratis.ctx=org`,
        });
      }
      return new TenantPool(
        { connectionString: appUrl, max: 1 },
        { alwaysStamp: kind === 'tenant-always' },
      );
    };
    const out: Array<Record<string, unknown>> = [];
    for (const query of ['trivial', 'list'] as const) {
      for (const setup of [
        { name: 'plain pool, owner (today)', kind: 'owner' as const, alternate: false },
        {
          name: 'plain pool, app role, org set at login (policy, no stamp)',
          kind: 'app-fixed' as const,
          alternate: false,
        },
        {
          name: 'TenantPool, same org each time (stamp skipped)',
          kind: 'tenant' as const,
          alternate: false,
        },
        {
          name: 'TenantPool, org changes each time (stamp written)',
          kind: 'tenant' as const,
          alternate: true,
        },
        { name: 'TenantPool, alwaysStamp', kind: 'tenant-always' as const, alternate: false },
      ]) {
        const pool = make(setup.kind);
        const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
        const times: number[] = [];
        const iterations =
          query === 'list' ? Math.max(200, Math.floor(STAMP_ITER / 4)) : STAMP_ITER;
        try {
          for (let i = 0; i < iterations + 50; i += 1) {
            const org = setup.alternate && i % 2 ? orgId(n + 1) : orgId(n);
            const t0 = performance.now();
            await runAsOrg(org, async () => {
              if (query === 'trivial') await prisma.$queryRaw`SELECT 1`;
              else
                await prisma.item.findMany({
                  where,
                  select: { id: true, title: true, type: true, updatedAt: true },
                  orderBy: { updatedAt: 'desc' },
                  take: 50,
                });
            });
            if (i >= 50) times.push(performance.now() - t0);
          }
        } finally {
          await prisma.$disconnect();
          if (!pool.ended) await pool.end();
        }
        out.push({
          query:
            query === 'trivial' ? 'SELECT 1 through Prisma' : 'item list, 50 rows, through Prisma',
          setup: setup.name,
          iterations,
          medianMs: round(median(times)),
          p95Ms: round(pct(times, 95)),
        });
      }
    }
    // The bare round trip of the stamp statement on a held connection.
    const barePool = new Pool({ connectionString: appUrl, max: 1 });
    const c = await barePool.connect();
    const bare: number[] = [];
    for (let i = 0; i < STAMP_ITER; i += 1) {
      const t0 = performance.now();
      await c.query(
        "SELECT set_config('gratis.org_id', $1, false), set_config('gratis.ctx', 'org', false), set_config('gratis.user_id', '', false)",
        [i % 2 ? orgId(n) : orgId(n + 1)],
      );
      bare.push(performance.now() - t0);
    }
    c.release(true);
    await barePool.end();
    out.push({
      query: 'the stamp statement alone',
      setup: 'held connection',
      iterations: STAMP_ITER,
      medianMs: round(median(bare)),
      p95Ms: round(pct(bare, 95)),
    });
    results.stamp = out;
    save();
  });

  it('observation: bulk import speed with and without a write lock', async () => {
    const lineFor = (i: number) => {
      const lon = (-80 + (i % 1000) / 1000).toFixed(6);
      const lat = (38 + Math.floor(i / 1000) / 2000).toFixed(6);
      const attrs = JSON.stringify({
        apn: `${100 + (i % 900)}-${(i * 7) % 1000}-${(i * 13) % 1000}`,
        owner: `OWNER ${i % 5000} FAMILY TRUST`,
        situs: `${i % 9999} MAIN ST`,
        acres: (i % 1000) / 10,
        status: i % 3 ? 'open' : 'closed',
        notes: 'parcel record from the county assessor roll',
      });
      return `${randomUUID()}\t2026-11-25 00:00:00+00\t2026-11-25 00:00:00+00\t\\N\t${SCOPE}\t${randomUUID()}\tcreate\t${attrs}\tSRID=4326;POINT(${lon} ${lat})\t\\N\timport\t{"kind":"import"}\t{}\n`;
    };
    const COLS =
      '(id, tx_time, valid_from, valid_to, scope, entity, kind, attrs, geom, cell, author_sub, source, parents)';

    async function stream(client: PoolClient, sql: string): Promise<void> {
      const s = client.query(copyFrom(sql)) as unknown as Writable;
      const done = new Promise<void>((resolve, reject) => {
        s.on('finish', resolve);
        s.on('error', reject);
      });
      const BATCH = 2000;
      for (let start = 0; start < ROWS; start += BATCH) {
        let chunk = '';
        for (let i = start; i < Math.min(ROWS, start + BATCH); i += 1) chunk += lineFor(i);
        if (!s.write(chunk)) await new Promise((r) => s.once('drain', r));
      }
      s.end();
      await done;
    }

    const variants: Array<{
      name: string;
      setup: string;
      run: (c: PoolClient) => Promise<void>;
    }> = [
      {
        name: 'no lock: COPY into observation (today)',
        setup: '',
        run: (c) => stream(c, `COPY observation ${COLS} FROM STDIN WITH (FORMAT text)`),
      },
      {
        name: 'writes-only policy: COPY into a temp table, then INSERT ... SELECT',
        setup: OBSERVATION_WRITES_ONLY_SQL,
        run: async (c) => {
          await c.query(
            'CREATE TEMP TABLE obs_stage (LIKE observation INCLUDING DEFAULTS) ON COMMIT DROP',
          );
          await stream(c, `COPY obs_stage ${COLS} FROM STDIN WITH (FORMAT text)`);
          await c.query(`INSERT INTO observation SELECT * FROM obs_stage`);
        },
      },
      {
        name: 'no lock, same temp table route (to separate its own cost)',
        setup: '',
        run: async (c) => {
          await c.query(
            'CREATE TEMP TABLE obs_stage (LIKE observation INCLUDING DEFAULTS) ON COMMIT DROP',
          );
          await stream(c, `COPY obs_stage ${COLS} FROM STDIN WITH (FORMAT text)`);
          await c.query(`INSERT INTO observation SELECT * FROM obs_stage`);
        },
      },
      {
        name: 'row trigger lock: COPY into observation, each row checked',
        setup: `
          CREATE OR REPLACE FUNCTION gg_measure_obs_row_check() RETURNS trigger LANGUAGE plpgsql AS $f$
          BEGIN
            IF NOT EXISTS (SELECT 1 FROM item i WHERE i.id = gg_scope_item_id(NEW.scope) AND i.org_id = gg_org_id()) THEN
              RAISE EXCEPTION 'layer belongs to another organization' USING ERRCODE = '42501';
            END IF;
            RETURN NEW;
          END $f$;
          CREATE TRIGGER gg_measure_obs_row BEFORE INSERT ON observation
            FOR EACH ROW EXECUTE FUNCTION gg_measure_obs_row_check();`,
        run: (c) => stream(c, `COPY observation ${COLS} FROM STDIN WITH (FORMAT text)`),
      },
      {
        name: 'statement trigger lock: COPY into observation, scopes checked once',
        setup: `
          CREATE OR REPLACE FUNCTION gg_measure_obs_stmt_check() RETURNS trigger LANGUAGE plpgsql AS $f$
          BEGIN
            IF EXISTS (
              SELECT 1 FROM (SELECT DISTINCT scope FROM gg_new_rows) s
              WHERE NOT EXISTS (SELECT 1 FROM item i WHERE i.id = gg_scope_item_id(s.scope) AND i.org_id = gg_org_id())
            ) THEN
              RAISE EXCEPTION 'layer belongs to another organization' USING ERRCODE = '42501';
            END IF;
            RETURN NULL;
          END $f$;
          CREATE TRIGGER gg_measure_obs_stmt AFTER INSERT ON observation
            REFERENCING NEW TABLE AS gg_new_rows
            FOR EACH STATEMENT EXECUTE FUNCTION gg_measure_obs_stmt_check();`,
        run: (c) => stream(c, `COPY observation ${COLS} FROM STDIN WITH (FORMAT text)`),
      },
    ];
    const teardown = `${OBSERVATION_NO_POLICY_SQL}
      DROP TRIGGER IF EXISTS gg_measure_obs_row ON observation;
      DROP TRIGGER IF EXISTS gg_measure_obs_stmt ON observation;`;

    const pool = new TenantPool({ connectionString: appUrl, max: 1 });
    const out: Array<Record<string, unknown>> = [];
    try {
      for (let rep = 0; rep < REPEATS; rep += 1) {
        for (const v of variants) {
          await owner.query(teardown);
          await owner.query('TRUNCATE observation');
          await owner.query('CHECKPOINT');
          if (v.setup) await owner.query(v.setup);
          const t0 = performance.now();
          await runAsOrg(orgId(7), async () => {
            const c = await pool.connect();
            try {
              await c.query('BEGIN');
              await c.query('SET LOCAL statement_timeout = 0');
              await v.run(c);
              await c.query('COMMIT');
            } catch (err) {
              await c.query('ROLLBACK').catch(() => undefined);
              throw err;
            } finally {
              c.release();
            }
          });
          const seconds = (performance.now() - t0) / 1000;
          const count = await owner.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM observation',
          );
          const size = await owner.query<{ s: string; db: string }>(
            "SELECT pg_size_pretty(sum(pg_total_relation_size(c.oid))) AS s, pg_size_pretty(pg_database_size(current_database())) AS db FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'observation'::regclass",
          );
          out.push({
            variant: v.name,
            repeat: rep + 1,
            rows: count.rows[0]!.n,
            seconds: round(seconds, 2),
            rowsPerSecond: Math.round(count.rows[0]!.n / seconds),
            tableSize: size.rows[0]!.s,
            databaseSize: size.rows[0]!.db,
          });
          results.observation = out;
          save();
        }
      }
      // The lock refuses another org's layer, and COPY under a policy
      // is refused outright.
      await owner.query(teardown);
      await owner.query('TRUNCATE observation');
      await owner.query(OBSERVATION_WRITES_ONLY_SQL);
      const refused = await runAsOrg(orgId(7), async () => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const s = c.query(
            copyFrom(`COPY observation ${COLS} FROM STDIN WITH (FORMAT text)`),
          ) as unknown as Writable;
          const err = await new Promise<string>((resolve) => {
            s.on('error', (e: Error) => resolve(e.message));
            s.on('finish', () => resolve('accepted'));
            s.end(lineFor(1));
          });
          await c.query('ROLLBACK');
          return err;
        } finally {
          c.release();
        }
      });
      results.copyUnderPolicy = refused;
    } finally {
      await owner.query(teardown);
      await owner.query('TRUNCATE observation');
      await pool.end();
      save();
    }
  });
});
