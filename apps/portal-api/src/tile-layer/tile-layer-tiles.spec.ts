// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Unit spec for the server-side XYZ tile endpoint.
 *
 * The route is @Public, so its three moving parts are worth pinning
 * without a database or a MinIO round trip: the coordinate parser
 * (the endpoint's entire input surface), the archive-header to
 * Content-Type mapping a client decodes by, and the bounded pool of
 * open archives that keeps a tile from costing three ranged reads.
 *
 * Also covers the pass-through case in resolveStorageKey, because a
 * .pmtiles the user uploaded directly never runs the pyramid worker
 * and so never gets a pmtilesStorageKey.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PMTiles, TileType, type Source } from 'pmtiles';

import { parseTileCoords } from './tile-layer.controller.js';
import {
  PmtilesArchiveCache,
  TileLayerService,
  tileTypeContentType,
} from './tile-layer.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

const ITEM_ID = '22222222-2222-7222-8222-222222222222';

describe('parseTileCoords', () => {
  it('accepts the origin tile and other in-range addresses', () => {
    expect(parseTileCoords('0', '0', '0')).toEqual({ z: 0, x: 0, y: 0 });
    expect(parseTileCoords('12', '1205', '1539')).toEqual({
      z: 12,
      x: 1205,
      y: 1539,
    });
    // Highest address the cap allows, on both axes.
    expect(parseTileCoords('24', '16777215', '16777215')).toEqual({
      z: 24,
      x: 16777215,
      y: 16777215,
    });
    // Leading zeros are still plain digits.
    expect(parseTileCoords('07', '003', '004')).toEqual({ z: 7, x: 3, y: 4 });
  });

  it('rejects negatives', () => {
    expect(() => parseTileCoords('-1', '0', '0')).toThrow(BadRequestException);
    expect(() => parseTileCoords('3', '-1', '0')).toThrow(BadRequestException);
    expect(() => parseTileCoords('3', '0', '-2')).toThrow(BadRequestException);
  });

  it('rejects anything that is not a plain run of digits', () => {
    // Every one of these is a finite integer to Number(), which is
    // exactly why the parser cannot lean on Number() alone.
    for (const bad of ['', ' ', ' 2 ', '1e3', '0x10', '2.0', '+2', 'abc', '3.png']) {
      expect(() => parseTileCoords(bad, '0', '0')).toThrow(BadRequestException);
      expect(() => parseTileCoords('3', bad, '0')).toThrow(BadRequestException);
      expect(() => parseTileCoords('3', '0', bad)).toThrow(BadRequestException);
    }
  });

  it('rejects x or y at or past 2**z', () => {
    expect(() => parseTileCoords('0', '1', '0')).toThrow(BadRequestException);
    expect(() => parseTileCoords('0', '0', '1')).toThrow(BadRequestException);
    expect(() => parseTileCoords('1', '2', '0')).toThrow(BadRequestException);
    expect(() => parseTileCoords('10', '1024', '0')).toThrow(
      BadRequestException,
    );
    expect(() => parseTileCoords('10', '0', '99999')).toThrow(
      BadRequestException,
    );
    // One below the span on each axis is the valid boundary.
    expect(parseTileCoords('1', '1', '1')).toEqual({ z: 1, x: 1, y: 1 });
  });

  it('rejects zoom past the cap', () => {
    expect(() => parseTileCoords('25', '0', '0')).toThrow(BadRequestException);
    expect(() => parseTileCoords('99', '0', '0')).toThrow(BadRequestException);
    // A digit run long enough to overflow to Infinity must not slip
    // through as "a very deep zoom".
    expect(() => parseTileCoords('9'.repeat(400), '0', '0')).toThrow(
      BadRequestException,
    );
  });
});

describe('tileTypeContentType', () => {
  it('maps every tile type the PMTiles spec defines', () => {
    expect(tileTypeContentType(TileType.Mvt)).toBe(
      'application/vnd.mapbox-vector-tile',
    );
    expect(tileTypeContentType(TileType.Png)).toBe('image/png');
    expect(tileTypeContentType(TileType.Jpeg)).toBe('image/jpeg');
    expect(tileTypeContentType(TileType.Webp)).toBe('image/webp');
    expect(tileTypeContentType(TileType.Avif)).toBe('image/avif');
  });

  it('pins the enum to the wire values, not just to itself', () => {
    // The mapping is only correct if these are the numbers a real
    // archive header carries, so assert the literals too.
    expect(tileTypeContentType(1)).toBe('application/vnd.mapbox-vector-tile');
    expect(tileTypeContentType(2)).toBe('image/png');
    expect(tileTypeContentType(3)).toBe('image/jpeg');
    expect(tileTypeContentType(4)).toBe('image/webp');
    expect(tileTypeContentType(5)).toBe('image/avif');
  });

  it('falls back to octet-stream for unknown and future types', () => {
    expect(tileTypeContentType(TileType.Unknown)).toBe(
      'application/octet-stream',
    );
    expect(tileTypeContentType(0)).toBe('application/octet-stream');
    expect(tileTypeContentType(6)).toBe('application/octet-stream');
    expect(tileTypeContentType(-1)).toBe('application/octet-stream');
  });
});

describe('PmtilesArchiveCache', () => {
  /**
   * A PMTiles instance constructed over a Source does no I/O until
   * something asks it for bytes, so the cache can be exercised with
   * a source that would throw if anyone tried.
   */
  const openArchive = (key: string): PMTiles => {
    const source: Source = {
      getKey: () => key,
      getBytes: () => {
        throw new Error('the cache spec must never touch storage');
      },
    };
    return new PMTiles(source);
  };

  it('returns the same instance for the same key', () => {
    const cache = new PmtilesArchiveCache(4);
    const open = jest.fn(openArchive);
    const first = cache.get('item-tile-layer/a', open);
    const second = cache.get('item-tile-layer/a', open);
    expect(second).toBe(first);
    // The point of the cache: the second call opened nothing, so the
    // header and root directory were not re-read.
    expect(open).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
  });

  it('keeps distinct keys apart', () => {
    const cache = new PmtilesArchiveCache(4);
    const a = cache.get('item-tile-layer/a', openArchive);
    const b = cache.get('item-tile-layer/b', openArchive);
    expect(b).not.toBe(a);
    expect(a.source.getKey()).toBe('item-tile-layer/a');
    expect(b.source.getKey()).toBe('item-tile-layer/b');
    expect(cache.size).toBe(2);
  });

  it('stays at its cap and drops the oldest entry first', () => {
    const cache = new PmtilesArchiveCache(3);
    const first = cache.get('k0', openArchive);
    cache.get('k1', openArchive);
    cache.get('k2', openArchive);
    expect(cache.size).toBe(3);

    cache.get('k3', openArchive);
    expect(cache.size).toBe(3);
    // k0 went out, so re-asking for it opens a fresh instance.
    const reopened = cache.get('k0', openArchive);
    expect(reopened).not.toBe(first);
    expect(cache.size).toBe(3);
    // k1 was evicted in turn by k0 coming back; k2 and k3 survive.
    const open = jest.fn(openArchive);
    cache.get('k3', open);
    expect(open).not.toHaveBeenCalled();
  });

  it('never grows past the cap under sustained churn', () => {
    const cache = new PmtilesArchiveCache(32);
    for (let i = 0; i < 500; i++) cache.get(`k${i}`, openArchive);
    expect(cache.size).toBe(32);
  });
});

/**
 * The XYZ endpoint resolves its archive through
 * resolveStorageKey(user, id, 'pmtiles'), so the pass-through case
 * has to work: a .pmtiles uploaded directly is served straight
 * through and never acquires a pmtilesStorageKey.
 */
describe('TileLayerService.resolveStorageKey (pmtiles pin)', () => {
  function makeService(data: unknown) {
    const items = {
      get: jest.fn(async () => ({ id: ITEM_ID, type: 'tile_layer', data })),
    };
    const service = new TileLayerService(
      items as unknown as ConstructorParameters<typeof TileLayerService>[0],
      {} as ConstructorParameters<typeof TileLayerService>[1],
      {} as ConstructorParameters<typeof TileLayerService>[2],
      {} as ConstructorParameters<typeof TileLayerService>[3],
      {} as ConstructorParameters<typeof TileLayerService>[4],
    );
    return { service, items };
  }

  const user = { id: 'u1', orgId: 'org-1' } as unknown as AuthUser;

  it('prefers the derived pyramid when the worker has built one', async () => {
    const { service } = makeService({
      version: 1,
      format: 'pmtiles',
      storageKey: 'item-tile-layer/pyramid',
      pmtilesStorageKey: 'item-tile-layer/pyramid',
      cogStorageKey: 'item-tile-layer/source-cog',
    });
    await expect(
      service.resolveStorageKey(user, ITEM_ID, 'pmtiles'),
    ).resolves.toBe('item-tile-layer/pyramid');
  });

  it('serves a directly uploaded archive that has no pyramid key', async () => {
    const { service } = makeService({
      version: 1,
      format: 'pmtiles',
      storageKey: 'item-tile-layer/uploaded',
    });
    await expect(
      service.resolveStorageKey(user, ITEM_ID, 'pmtiles'),
    ).resolves.toBe('item-tile-layer/uploaded');
  });

  it('still refuses to answer a pmtiles request with COG bytes', async () => {
    const { service } = makeService({
      version: 1,
      format: 'cog',
      storageKey: 'item-tile-layer/source-cog',
      cogStorageKey: 'item-tile-layer/source-cog',
    });
    await expect(
      service.resolveStorageKey(user, ITEM_ID, 'pmtiles'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('keeps the storage-key prefix pinned on the pass-through path', async () => {
    // item.data is owner-writable through the generic items PATCH,
    // so a key edited to point outside our prefix must read as
    // absent rather than stream another prefix's object.
    const { service } = makeService({
      version: 1,
      format: 'pmtiles',
      storageKey: 'feature-attachment/someone-elses-file',
    });
    await expect(
      service.resolveStorageKey(user, ITEM_ID, 'pmtiles'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
