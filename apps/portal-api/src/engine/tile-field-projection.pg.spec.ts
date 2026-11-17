// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A number field whose stored value does not parse (an empty string,
// or text from before the field's type changed) must project as null
// in a tile, not fail the whole tile with 22P02. Runs the projection
// over literal rows, so it needs a server but no tables.

import { Pool } from 'pg';

import { tileFieldProjection } from './data-layer.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the tile projection suite would silently skip.',
  );
}

d('tile field projection', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: TEST_URL, max: 1 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('casts numbers that parse and nulls the rest instead of failing', async () => {
    const rows = await pool.query<{ pop: string | null; name: string | null }>(
      `SELECT ${tileFieldProjection('pop', 'number')}, ${tileFieldProjection('name', 'string')}
       FROM (VALUES
         ('{"pop": "12.5", "name": "a"}'::jsonb),
         ('{"pop": "", "name": "b"}'::jsonb),
         ('{"pop": "lots", "name": "c"}'::jsonb),
         ('{"name": "d"}'::jsonb)
       ) AS t(attrs)`,
    );
    expect(rows.rows.map((r) => r.pop)).toEqual(['12.5', null, null, null]);
    expect(rows.rows.map((r) => r.name)).toEqual(['a', 'b', 'c', 'd']);
  });
});
