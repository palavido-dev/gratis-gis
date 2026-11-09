// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { itemDataFromBody } from './item-response';

describe('itemDataFromBody', () => {
  it('reads the item as GET /items/:id returns it', () => {
    expect(itemDataFromBody({ id: 'x', data: { a: 1 } })).toEqual({ a: 1 });
  });
  it('still reads a wrapped item', () => {
    expect(itemDataFromBody({ item: { data: { a: 2 } } })).toEqual({ a: 2 });
  });
  it('tolerates junk', () => {
    expect(itemDataFromBody(null)).toBeUndefined();
    expect(itemDataFromBody('x')).toBeUndefined();
  });
  it('is what the tile-layer editor polls with', () => {
    const src = readFileSync(
      join(__dirname, '..', 'app', 'items', '[id]', 'tile-layer', 'editor.tsx'),
      'utf8',
    );
    expect(src).not.toMatch(/body\.item\?\.data/);
    expect(src.match(/itemDataFromBody\(/g)?.length).toBe(2);
  });
});
