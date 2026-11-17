// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { xyzTreeToMbtiles } from './xyz-to-mbtiles.js';

/**
 * 20-8: a zip of XYZ tiles is packed into an MBTiles (the only input
 * the bundled pmtiles CLI converts). Rows are flipped to TMS order.
 */
describe('xyzTreeToMbtiles', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xyz-mbtiles-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function tile(rel: string, body: string) {
    const p = join(dir, 'tree', rel);
    await mkdir(join(p, '..'), { recursive: true });
    await writeFile(p, body);
  }

  it('packs a wrapped tree, flips rows and writes metadata', async () => {
    await tile('wrapped/0/0/0.png', 'z0');
    await tile('wrapped/1/0/0.png', 'z1-top-left');
    await tile('wrapped/1/1/1.png', 'z1-bottom-right');
    await tile('wrapped/readme.txt', 'ignored');
    const out = join(dir, 'out.mbtiles');
    const r = await xyzTreeToMbtiles(join(dir, 'tree'), out, 'parcels');
    expect(r).toEqual({ tiles: 3, format: 'png', minZoom: 0, maxZoom: 1 });

    const db = new DatabaseSync(out);
    try {
      const meta = Object.fromEntries(
        (db.prepare('SELECT name, value FROM metadata').all() as Array<{
          name: string;
          value: string;
        }>).map((m) => [m.name, m.value]),
      );
      expect(meta).toMatchObject({
        name: 'parcels',
        format: 'png',
        minzoom: '0',
        maxzoom: '1',
      });
      const row = (z: number, x: number, y: number) =>
        db
          .prepare(
            'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?',
          )
          .get(z, x, y) as { tile_data: Uint8Array } | undefined;
      // XYZ y=0 (top) is TMS row 1 at zoom 1.
      expect(Buffer.from(row(1, 0, 1)!.tile_data).toString()).toBe('z1-top-left');
      expect(Buffer.from(row(1, 1, 0)!.tile_data).toString()).toBe('z1-bottom-right');
      expect(Buffer.from(row(0, 0, 0)!.tile_data).toString()).toBe('z0');
    } finally {
      db.close();
    }
  });

  it('keeps rows as they are for a tree marked tms', async () => {
    await tile('1/0/0.png', 'bottom');
    await writeFile(
      join(dir, 'tree', 'metadata.json'),
      JSON.stringify({ scheme: 'tms', name: 'From metadata' }),
    );
    const out = join(dir, 'out.mbtiles');
    await xyzTreeToMbtiles(join(dir, 'tree'), out, 'x');
    const db = new DatabaseSync(out);
    try {
      expect(
        db.prepare('SELECT tile_row FROM tiles').get() as { tile_row: number },
      ).toEqual({ tile_row: 0 });
      expect(
        db.prepare("SELECT value FROM metadata WHERE name = 'name'").get(),
      ).toEqual({ value: 'From metadata' });
    } finally {
      db.close();
    }
  });

  it('refuses a zip with no tiles or mixed formats', async () => {
    await tile('notes/readme.txt', 'x');
    await expect(
      xyzTreeToMbtiles(join(dir, 'tree'), join(dir, 'a.mbtiles'), 'x'),
    ).rejects.toThrow(/no tiles/);
    await tile('0/0/0.png', 'a');
    await tile('1/0/0.jpg', 'b');
    await expect(
      xyzTreeToMbtiles(join(dir, 'tree'), join(dir, 'b.mbtiles'), 'x'),
    ).rejects.toThrow(/mixes tile formats/);
  });
});
