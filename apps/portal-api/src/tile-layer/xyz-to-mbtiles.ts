// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Pack an extracted XYZ tile tree into an MBTiles file (2026-11
 * review, 20-8). The image's go-pmtiles CLI converts MBTiles archives
 * only, not tile directories (pyramid.worker.ts hit the same wall), so
 * a .zip of {z}/{x}/{y}.png tiles used to fail every time. Node's
 * built-in SQLite writes the MBTiles here, and the existing
 * `pmtiles convert <file.mbtiles>` step takes it from there.
 *
 * Layout: any directory chain that ends in {z}/{x}/{y}.{ext} with
 * integer z, x and y. A zip that wraps the tree in a root folder works
 * the same as one that does not. Other files are ignored.
 *
 * Row order: MBTiles stores rows bottom up (TMS). XYZ trees count from
 * the top, so y is flipped, unless the tree's metadata.json says
 * "scheme": "tms".
 */

const TILE_EXT: Record<string, string> = {
  png: 'png',
  jpg: 'jpg',
  jpeg: 'jpg',
  webp: 'webp',
  pbf: 'pbf',
  mvt: 'pbf',
};

const INT = /^\d+$/;

export interface XyzTile {
  z: number;
  x: number;
  y: number;
  path: string;
  format: string;
}

export interface XyzToMbtilesResult {
  tiles: number;
  format: string;
  minZoom: number;
  maxZoom: number;
}

/** Every tile file under `root`, read from the {z}/{x}/{y}.ext tail. */
export async function listXyzTiles(root: string): Promise<XyzTile[]> {
  const out: XyzTile[] = [];
  async function walk(dir: string, trail: string[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, [...trail, e.name]);
        continue;
      }
      if (!e.isFile()) continue;
      const dot = e.name.lastIndexOf('.');
      if (dot <= 0) continue;
      const stem = e.name.slice(0, dot);
      const format = TILE_EXT[e.name.slice(dot + 1).toLowerCase()];
      const zs = trail.at(-2);
      const xs = trail.at(-1);
      if (!format || !zs || !xs) continue;
      if (!INT.test(zs) || !INT.test(xs) || !INT.test(stem)) continue;
      const z = Number(zs);
      const x = Number(xs);
      const y = Number(stem);
      const n = 2 ** z;
      if (z > 30 || x >= n || y >= n) continue;
      out.push({ z, x, y, path: full, format });
    }
  }
  await walk(root, []);
  return out;
}

/** Find a metadata.json anywhere in the tree (first one wins). */
async function readTreeMetadata(
  root: string,
): Promise<Record<string, unknown>> {
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name === 'metadata.json') {
        try {
          const parsed: unknown = JSON.parse(
            await readFile(join(dir, e.name), 'utf8'),
          );
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
          }
        } catch {
          // A broken metadata.json is not worth failing the upload.
        }
        return {};
      }
    }
    for (const e of entries) {
      if (e.isDirectory()) queue.push(join(dir, e.name));
    }
  }
  return {};
}

function lon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

function lat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/**
 * Write `outPath` as an MBTiles of every tile under `tileDir`. Throws
 * when the tree holds no tiles, or tiles of more than one format.
 */
export async function xyzTreeToMbtiles(
  tileDir: string,
  outPath: string,
  name: string,
): Promise<XyzToMbtilesResult> {
  const tiles = await listXyzTiles(tileDir);
  if (tiles.length === 0) {
    throw new Error(
      'The zip has no tiles in a {z}/{x}/{y}.png (or .jpg, .webp, .pbf) layout.',
    );
  }
  const formats = new Set(tiles.map((t) => t.format));
  if (formats.size > 1) {
    throw new Error(
      `The zip mixes tile formats (${[...formats].join(', ')}). Use one format.`,
    );
  }
  const format = tiles[0]!.format;
  const meta = await readTreeMetadata(tileDir);
  const tms = String(meta.scheme ?? '').toLowerCase() === 'tms';

  let minZoom = Infinity;
  let maxZoom = -Infinity;
  for (const t of tiles) {
    minZoom = Math.min(minZoom, t.z);
    maxZoom = Math.max(maxZoom, t.z);
  }
  // Bounds from the tiles at the most detailed zoom.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const t of tiles) {
    if (t.z !== maxZoom) continue;
    const yTop = tms ? 2 ** t.z - 1 - t.y : t.y;
    minX = Math.min(minX, t.x);
    maxX = Math.max(maxX, t.x);
    minY = Math.min(minY, yTop);
    maxY = Math.max(maxY, yTop);
  }
  const bounds = [
    lon(minX, maxZoom),
    lat(maxY + 1, maxZoom),
    lon(maxX + 1, maxZoom),
    lat(minY, maxZoom),
  ].map((v) => Number(v.toFixed(6)));

  const db = new DatabaseSync(outPath);
  try {
    db.exec(`
      CREATE TABLE metadata (name TEXT, value TEXT);
      CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
      CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);
    `);
    const putMeta = db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)');
    const metadata: Record<string, string> = {
      name: typeof meta.name === 'string' && meta.name ? meta.name : name,
      format,
      type: typeof meta.type === 'string' ? meta.type : 'overlay',
      minzoom: String(minZoom),
      maxzoom: String(maxZoom),
      bounds: bounds.join(','),
    };
    for (const key of ['description', 'attribution', 'version']) {
      const v = meta[key];
      if (typeof v === 'string' && v) metadata[key] = v;
    }
    // Vector tiles carry their layer list in the `json` row.
    if (format === 'pbf') {
      const vectorLayers = meta.vector_layers;
      metadata.json =
        typeof meta.json === 'string'
          ? meta.json
          : JSON.stringify({
              vector_layers: Array.isArray(vectorLayers) ? vectorLayers : [],
            });
    }
    for (const [k, v] of Object.entries(metadata)) putMeta.run(k, v);

    const putTile = db.prepare(
      'INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)',
    );
    db.exec('BEGIN');
    for (const t of tiles) {
      const row = tms ? t.y : 2 ** t.z - 1 - t.y;
      putTile.run(t.z, t.x, row, await readFile(t.path));
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  return { tiles: tiles.length, format, minZoom, maxZoom };
}
