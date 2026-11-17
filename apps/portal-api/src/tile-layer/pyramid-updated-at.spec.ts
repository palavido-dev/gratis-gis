// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The pyramid worker writes processingState and friends into
 * data_json with raw SQL. ItemsService.update detects a write that
 * landed between its read and its locked re-read by comparing
 * updated_at, so a raw write that leaves updated_at alone is invisible
 * to it and a tile_layer PATCH built from the older read reverts the
 * worker's state. Every data_json write in the worker must bump
 * updated_at in the same statement.
 */
describe('pyramid worker data_json writes', () => {
  it('set updated_at in every statement that sets data_json', () => {
    const src = readFileSync(join(__dirname, 'pyramid.worker.ts'), 'utf8');
    const statements = src.split('`').filter((part) => /SET\s[\s\S]*"data_json"\s*=/.test(part));
    expect(statements.length).toBeGreaterThanOrEqual(9);
    for (const sql of statements) {
      expect(sql).toMatch(/SET\s+"updated_at"\s*=\s*NOW\(\)/);
    }
  });
});
