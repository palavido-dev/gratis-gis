// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A crafted PMTiles archive could make one tile request inflate a
// small gzip tile into gigabytes (a 277 KB upload became a 256 MB tile
// and about 590 MB of RSS). Inflation is capped now.

import { gzipSync } from 'node:zlib';

import { PMTILES_MAX_INFLATED_BYTES, cappedPmtilesDecompress } from './tile-layer.service.js';

const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

describe('cappedPmtilesDecompress', () => {
  it('passes uncompressed data through and inflates ordinary gzip', async () => {
    const raw = Buffer.from('tile bytes');
    expect(Buffer.from(await cappedPmtilesDecompress(ab(raw), 1))).toEqual(raw);
    expect(Buffer.from(await cappedPmtilesDecompress(ab(gzipSync(raw)), 2))).toEqual(raw);
  });

  it('refuses a gzip bomb', async () => {
    const bomb = gzipSync(Buffer.alloc(PMTILES_MAX_INFLATED_BYTES + 1024));
    expect(bomb.byteLength).toBeLessThan(1024 * 1024);
    await expect(cappedPmtilesDecompress(ab(bomb), 2)).rejects.toThrow();
  });

  it('refuses compression it does not know', async () => {
    await expect(cappedPmtilesDecompress(ab(Buffer.from('x')), 3)).rejects.toThrow(/not supported/);
  });
});

describe('pooled PMTiles archive after a storage error', () => {
  it('opens a fresh archive on the next request instead of replaying the error', async () => {
    const { TileLayerService } = await import('./tile-layer.service.js');
    let calls = 0;
    const storage = {
      readRange: jest.fn(async () => {
        calls += 1;
        throw new Error('MinIO unavailable');
      }),
      streamObject: jest.fn(async () => {
        calls += 1;
        throw new Error('MinIO unavailable');
      }),
    };
    const svc = new TileLayerService({} as never, {} as never, storage as never, {} as never, {} as never);
    await expect(svc.getPmtilesTileByKey('item-tile-layer/k', 0, 0, 0)).rejects.toThrow();
    const after = calls;
    await expect(svc.getPmtilesTileByKey('item-tile-layer/k', 0, 0, 0)).rejects.toThrow();
    // The second request reached storage again: the failed header
    // promise was not served from a pooled instance.
    expect(calls).toBeGreaterThan(after);
  });
});
