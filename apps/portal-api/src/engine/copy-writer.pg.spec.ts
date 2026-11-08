// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CopyWriter against a real PostGIS: append de-dupe, a cancelled
// COPY, and two writers appending the same new entity. Also the
// analysis item publish, where the claim check and the item update
// are one statement so a reclaim that commits first wins.
//
// Skipped unless TEST_DATABASE_URL is set. CI sets REQUIRE_PG_SPECS
// so a missing database fails the job instead of looking green.

import { Pool } from 'pg';
import type { Observation } from '@gratis-gis/engine';

import { CopyWriter } from './copy-writer.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the COPY suite would silently skip.',
  );
}

jest.setTimeout(120_000);

const SCOPE = 'data_layer:copy-itest:layer';
const AUTHOR = { sub: 'copy-user', displayName: 'Copy user' };

function row(entity: string, id: string, when: Date): Observation {
  return {
    id,
    txTime: when,
    validFrom: when,
    validTo: null,
    scope: SCOPE,
    entity,
    kind: 'create',
    attrs: { name: id },
    geom: { type: 'Point', coordinates: [-79.9, 38.9] },
    cell: null,
    author: AUTHOR,
    source: { kind: 'test' },
    parents: [],
  };
}

async function countWhere(pool: Pool, sql: string, params: unknown[] = []): Promise<number> {
  const result = await pool.query<{ n: string }>(sql, params);
  return Number(result.rows[0]?.n ?? 0);
}

d('CopyWriter on PostGIS', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 4 });
    await pool.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await pool.query('DROP TABLE IF EXISTS observation CASCADE');
    await pool.query(`
      CREATE TABLE observation (
        id UUID NOT NULL,
        tx_time TIMESTAMPTZ NOT NULL DEFAULT now(),
        valid_from TIMESTAMPTZ NOT NULL,
        valid_to TIMESTAMPTZ,
        scope TEXT NOT NULL,
        entity UUID NOT NULL,
        kind TEXT NOT NULL,
        attrs JSONB,
        geom GEOMETRY(Geometry, 4326),
        cell CHAR(15),
        author_sub TEXT NOT NULL,
        source JSONB NOT NULL,
        parents UUID[] NOT NULL DEFAULT '{}',
        PRIMARY KEY (id, tx_time)
      ) PARTITION BY RANGE (tx_time)
    `);
    await pool.query(`
      CREATE TABLE observation_p_itest PARTITION OF observation
        FOR VALUES FROM ('2020-01-01') TO ('2100-01-01')
    `);
    await pool.query(`
      DO $$
      DECLARE
        wrapped bigint := 4294967296 + 42;
        low xid := '42';
      BEGIN
        IF low::text::bigint = wrapped THEN
          RAISE EXCEPTION 'epoch compare matched a wrapped xid';
        END IF;
        IF low IS DISTINCT FROM (wrapped % 4294967296)::text::xid8::xid THEN
          RAISE EXCEPTION 'xid compare missed a wrapped xid';
        END IF;
      END $$
    `);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM observation');
  });

  it('keeps committed history and drops only this load’s duplicate creates', async () => {
    const entity = '11111111-1111-1111-1111-111111111111';
    const fresh = '22222222-2222-2222-2222-222222222222';
    await pool.query(
      `INSERT INTO observation
         (id, tx_time, valid_from, scope, entity, kind, attrs, author_sub, source)
       VALUES
         ($1, '2026-01-01', '2026-01-01', $2, $3, 'create', '{"n":1}', 'past', '{"kind":"web"}'),
         ($4, '2026-01-02', '2026-01-02', $2, $3, 'update', '{"n":2}', 'past', '{"kind":"web"}')`,
      [
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
        SCOPE,
        entity,
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
      ],
    );
    const writer = new CopyWriter(TEST_URL!);
    await writer.begin();
    writer.beginCopy();
    const t0 = new Date('2026-06-01T00:00:00Z');
    const t1 = new Date('2026-06-01T00:00:01Z');
    await writer.writeBatch([
      row(entity, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', t0),
      row(fresh, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2', t0),
      row(fresh, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb3', t1),
    ]);
    await writer.sealCopy();
    const removed = await writer.dropDuplicateAppendCreates(SCOPE);
    await writer.commit();
    await writer.close();
    expect(removed).toBe(2);
    expect(
      await countWhere(
        pool,
        `SELECT count(*)::text AS n FROM observation WHERE id = $1`,
        ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'],
      ),
    ).toBe(1);
    expect(
      await countWhere(
        pool,
        `SELECT count(*)::text AS n FROM observation WHERE id = $1`,
        ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'],
      ),
    ).toBe(1);
    expect(
      await countWhere(
        pool,
        `SELECT count(*)::text AS n FROM observation WHERE entity = $1 AND tx_time >= '2026-06-01'`,
        [entity],
      ),
    ).toBe(0);
    expect(
      await countWhere(
        pool,
        `SELECT count(*)::text AS n FROM observation WHERE entity = $1`,
        [fresh],
      ),
    ).toBe(1);
  });

  it('rolls a cancelled COPY back, including a replace delete in the same transaction', async () => {
    const entity = '33333333-3333-3333-3333-333333333333';
    await pool.query(
      `INSERT INTO observation
         (id, tx_time, valid_from, scope, entity, kind, attrs, author_sub, source)
       VALUES ($1, '2026-03-01', '2026-03-01', $2, $3, 'create', '{}', 'past', '{"kind":"web"}')`,
      ['cccccccc-cccc-cccc-cccc-ccccccccccc1', SCOPE, entity],
    );
    const writer = new CopyWriter(TEST_URL!);
    await writer.begin();
    await writer.deleteScope(SCOPE);
    writer.beginCopy();
    await writer.writeBatch([
      row(entity, 'dddddddd-dddd-dddd-dddd-ddddddddddd1', new Date('2026-06-02T00:00:00Z')),
    ]);
    await writer.abort();
    await writer.close();
    expect(await countWhere(pool, 'SELECT count(*)::text AS n FROM observation')).toBe(1);
    expect(
      await countWhere(
        pool,
        `SELECT count(*)::text AS n FROM observation WHERE id = $1`,
        ['cccccccc-cccc-cccc-cccc-ccccccccccc1'],
      ),
    ).toBe(1);
  });

  it('lets two appends of one new entity commit exactly one create', async () => {
    const entity = '44444444-4444-4444-4444-444444444444';
    const writeOne = async (id: string, when: string) => {
      const writer = new CopyWriter(TEST_URL!);
      await writer.begin();
      writer.beginCopy();
      await writer.writeBatch([row(entity, id, new Date(when))]);
      await writer.sealCopy();
      await writer.dropDuplicateAppendCreates(SCOPE);
      await writer.commit();
      await writer.close();
    };
    await Promise.all([
      writeOne('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1', '2026-06-03T00:00:00Z'),
      writeOne('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2', '2026-06-03T00:00:01Z'),
    ]);
    expect(
      await countWhere(
        pool,
        `SELECT count(*)::text AS n FROM observation WHERE entity = $1 AND kind = 'create'`,
        [entity],
      ),
    ).toBe(1);
  });
});

d('analysis item publish on PostGIS', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 4 });
    await pool.query('DROP TABLE IF EXISTS item');
    await pool.query('DROP TABLE IF EXISTS analysis_job');
    await pool.query(`
      CREATE TABLE analysis_job (
        id uuid PRIMARY KEY,
        state text NOT NULL,
        claim_token uuid
      )
    `);
    await pool.query(`
      CREATE OR REPLACE FUNCTION analysis_job_lease_guard()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        presented text;
        reclaim text;
      BEGIN
        IF OLD.claim_token IS NULL THEN
          RETURN NEW;
        END IF;
        IF OLD.state = 'queued' AND NEW.state = 'running' THEN
          RETURN NEW;
        END IF;
        reclaim := current_setting('gratis.reclaim', true);
        IF reclaim = '1' THEN
          RETURN NEW;
        END IF;
        presented := current_setting('gratis.claim_token', true);
        IF presented IS NOT DISTINCT FROM OLD.claim_token::text THEN
          RETURN NEW;
        END IF;
        RETURN NULL;
      END $$
    `);
    await pool.query('DROP TRIGGER IF EXISTS analysis_job_lease_guard ON analysis_job');
    await pool.query(`
      CREATE TRIGGER analysis_job_lease_guard
      BEFORE UPDATE ON analysis_job
      FOR EACH ROW EXECUTE FUNCTION analysis_job_lease_guard()
    `);
    await pool.query(`
      CREATE TABLE item (
        id uuid PRIMARY KEY,
        data_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz
      )
    `);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM item');
    await pool.query('DELETE FROM analysis_job');
  });

  function publish() {
    return `
      WITH held AS (
        SELECT id FROM analysis_job
        WHERE id = $1
          AND claim_token = $2::uuid
          AND state IN ('running', 'cancel_requested')
        FOR UPDATE
      )
      UPDATE item
      SET data_json = data_json || $3::jsonb, updated_at = now()
      WHERE id = $4
        AND EXISTS (SELECT 1 FROM held)
    `;
  }

  it('does not publish when the claim token no longer matches', async () => {
    const job = '55555555-5555-5555-5555-555555555555';
    const item = '66666666-6666-6666-6666-666666666666';
    const token = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await pool.query(
      `INSERT INTO analysis_job (id, state, claim_token) VALUES ($1, 'running', $2)`,
      [job, token],
    );
    await pool.query(`INSERT INTO item (id, data_json) VALUES ($1, '{"keep":1}')`, [item]);
    const stale = await pool.query(publish(), [
      job,
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      JSON.stringify({ processingState: 'stale' }),
      item,
    ]);
    expect(stale.rowCount).toBe(0);
    const doc = await pool.query<{ data_json: { keep?: number; processingState?: string } }>(
      'SELECT data_json FROM item WHERE id = $1',
      [item],
    );
    expect(doc.rows[0]?.data_json).toEqual({ keep: 1 });
  });

  it('a reclaim that commits while publish waits leaves the item unchanged', async () => {
    const job = '77777777-7777-7777-7777-777777777777';
    const item = '88888888-8888-8888-8888-888888888888';
    const oldToken = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const newToken = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    await pool.query(
      `INSERT INTO analysis_job (id, state, claim_token) VALUES ($1, 'running', $2)`,
      [job, oldToken],
    );
    await pool.query(`INSERT INTO item (id, data_json) VALUES ($1, '{"keep":1}')`, [item]);
    const holder = await pool.connect();
    const publisher = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM analysis_job WHERE id = $1 FOR UPDATE', [job]);
      const pending = publisher.query(publish(), [
        job,
        oldToken,
        JSON.stringify({ processingState: 'late' }),
        item,
      ]);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await holder.query(`SELECT set_config('gratis.claim_token', $1, true)`, [oldToken]);
      await holder.query(
        `UPDATE analysis_job SET claim_token = $2 WHERE id = $1`,
        [job, newToken],
      );
      await holder.query('COMMIT');
      const published = await pending;
      expect(published.rowCount).toBe(0);
      const doc = await pool.query<{ data_json: { processingState?: string } }>(
        'SELECT data_json FROM item WHERE id = $1',
        [item],
      );
      expect(doc.rows[0]?.data_json.processingState).toBeUndefined();
    } finally {
      publisher.release();
      holder.release(true);
    }
  });
});
