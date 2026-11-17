// SPDX-License-Identifier: AGPL-3.0-or-later
import { DerivedResultCache, queryHash, scopesInSql } from './result-cache.js';

const row = (id: string, geom = 'x') => ({
  global_id: id,
  geom,
  properties: null,
});

describe('derived-layer result cache (07-7)', () => {
  it('finds every source scope in the SQL, quotes undone', () => {
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    const sql = `WITH s AS (SELECT * FROM observation WHERE scope = 'data_layer:${b}:default'),
      r AS (SELECT * FROM observation WHERE scope = 'data_layer:${a}:o''brien')
      SELECT 'data_layer:${b}:default'`;
    expect(scopesInSql(sql)).toEqual([
      `data_layer:${a}:o'brien`,
      `data_layer:${b}:default`,
    ]);
  });

  it('keys on parameters as well as SQL text', () => {
    expect(queryHash('q', [1])).not.toBe(queryHash('q', [2]));
    expect(queryHash('q', [1])).toBe(queryHash('q', [1]));
  });

  it('expires entries after the TTL', () => {
    let t = 0;
    const cache = new DerivedResultCache(1000, 10, 1e9, () => t);
    cache.set('k', [row('a')]);
    t = 999;
    expect(cache.get('k')).toHaveLength(1);
    t = 1000;
    expect(cache.get('k')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('drops the least recently used entry when full', () => {
    const cache = new DerivedResultCache(60_000, 2, 1e9);
    cache.set('a', [row('a')]);
    cache.set('b', [row('b')]);
    cache.get('a');
    cache.set('c', [row('c')]);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('keeps under its memory budget and skips a result bigger than it', () => {
    const cache = new DerivedResultCache(60_000, 10, 400);
    cache.set('a', [row('a', 'g'.repeat(100))]);
    cache.set('b', [row('b', 'g'.repeat(100))]);
    // Each row counts about 164; a + b + c would be over 400, so the oldest goes.
    cache.set('c', [row('c', 'g'.repeat(100))]);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(2);
    cache.set('huge', [row('h', 'g'.repeat(1000))]);
    expect(cache.get('huge')).toBeUndefined();
    expect(cache.size).toBe(2);
  });
});
