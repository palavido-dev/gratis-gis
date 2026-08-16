// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The decisions behind the COG tile route, without GDAL.
 *
 * The route exists because a COG-backed layer could previously only
 * be read by a desktop GIS through GDAL's /vsicurl, and opening a
 * saved project containing one deadlocks QGIS: providers are built on
 * a worker pool during project read while the GUI thread waits, and a
 * /vsicurl provider never returns. Adding the layer by hand always
 * worked, which is what made it look intermittent for weeks.
 *
 * Each argument builder here got its shape from a probe against the
 * real prod imagery and elevation COGs. The values are pinned so a
 * later tidy-up cannot quietly undo one, since the failure modes are
 * a tile that is blank, black, or white rather than an exception.
 */
import {
  COG_TILE_SIZE,
  grayscaleArgs,
  isValidTileAddress,
  needsAlphaBand,
  needsRendering,
  tileBounds3857,
  tileBoundsWgs84,
  warpArgs,
} from './cog-tiles.js';
import { CogTileService } from './cog-tiles.service.js';

/** Read `-flag value` out of an argument list. */
function argAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

describe('tileBounds3857', () => {
  it('gives the whole world for the origin tile', () => {
    const b = tileBounds3857(0, 0, 0);
    expect(b.minX).toBeCloseTo(-20037508.34, 1);
    expect(b.maxX).toBeCloseTo(20037508.34, 1);
    expect(b.minY).toBeCloseTo(-20037508.34, 1);
    expect(b.maxY).toBeCloseTo(20037508.34, 1);
  });

  it('counts y downward from the north, the XYZ way', () => {
    // Getting this inverted is the classic tile bug: everything
    // draws, mirrored about the equator, and looks plausible until
    // someone checks a coastline.
    const north = tileBounds3857(1, 0, 0);
    const south = tileBounds3857(1, 0, 1);
    expect(north.maxY).toBeGreaterThan(south.maxY);
    expect(north.minY).toBeCloseTo(0, 6);
    expect(south.maxY).toBeCloseTo(0, 6);
  });

  it('tiles a zoom level with no gaps or overlaps', () => {
    const a = tileBounds3857(3, 2, 5);
    const b = tileBounds3857(3, 3, 5);
    expect(b.minX).toBeCloseTo(a.maxX, 6);
  });
});

describe('tileBoundsWgs84', () => {
  it('places a known tile over the right ground', () => {
    // z14/4548/6276 covers the Randolph County imagery footprint,
    // which is the raster this route was first proved against.
    const [w, s, e, n] = tileBoundsWgs84(14, 4548, 6276);
    expect(w).toBeGreaterThan(-80.11);
    expect(e).toBeLessThan(-80.02);
    expect(s).toBeGreaterThan(38.7);
    expect(n).toBeLessThan(38.8);
  });
});

describe('needsAlphaBand', () => {
  it('adds one when the source has no alpha', () => {
    // The prod imagery COG is Red/Green/Blue with no alpha, and
    // without the added band everything outside the footprint warps
    // to black instead of transparent.
    expect(needsAlphaBand('Blue')).toBe(true);
    expect(needsAlphaBand('Gray')).toBe(true);
    expect(needsAlphaBand('Undefined')).toBe(true);
  });

  it('leaves a source that already has alpha alone', () => {
    // Adding a fifth band to an RGBA source makes the PNG driver
    // refuse the write, so every tile of that layer would 500.
    expect(needsAlphaBand('Alpha')).toBe(false);
  });
});

describe('warpArgs', () => {
  const bounds = tileBounds3857(14, 4548, 6276);

  it('asks for a 256px web-mercator tile over the given ground', () => {
    const args = warpArgs(bounds, true);
    expect(argAfter(args, '-t_srs')).toBe('EPSG:3857');
    const te = args.indexOf('-te');
    expect(args.slice(te + 1, te + 5).map(Number)).toEqual([
      bounds.minX,
      bounds.minY,
      bounds.maxX,
      bounds.maxY,
    ]);
    const ts = args.indexOf('-ts');
    expect(args.slice(ts + 1, ts + 3)).toEqual([
      String(COG_TILE_SIZE),
      String(COG_TILE_SIZE),
    ]);
  });

  it('writes to an in-memory dataset', () => {
    // The output is encoded to PNG and thrown away; a file format
    // here would put a temp file on the container disk per tile.
    expect(argAfter(warpArgs(bounds, true), '-of')).toBe('MEM');
  });

  it('resamples bilinearly', () => {
    // These are pictures being downsampled hard at low zoom, where
    // nearest-neighbour aliases into a visible shimmer.
    expect(argAfter(warpArgs(bounds, true), '-r')).toBe('bilinear');
  });

  it('adds the alpha band only when asked', () => {
    expect(warpArgs(bounds, true)).toContain('-dstalpha');
    expect(warpArgs(bounds, false)).not.toContain('-dstalpha');
  });
});

describe('needsRendering', () => {
  it('passes 8-bit data straight through', () => {
    // Imagery is already what PNG stores; rendering it would only
    // lose colour.
    expect(needsRendering('Byte')).toBe(false);
  });

  it('renders anything PNG cannot hold', () => {
    // The prod elevation COGs are Float64. Handing those to the PNG
    // driver writes whatever the cast produces: an elevation of 900
    // clamps to 255 and the tile comes out solid white. Confirmed by
    // doing exactly that against the Elkins DEM.
    for (const t of ['Float64', 'Float32', 'Int16', 'UInt16', 'Int32']) {
      expect(needsRendering(t)).toBe(true);
    }
  });
});

describe('grayscaleArgs', () => {
  it('writes the data band three times to make grey', () => {
    const args = grayscaleArgs(2, 500, 1180);
    const bands = args.reduce<string[]>(
      (acc, a, i) => (a === '-b' ? [...acc, args[i + 1]!] : acc),
      [],
    );
    expect(bands).toEqual(['1', '1', '1', '2']);
  });

  it('stretches the colour bands over the range it was given', () => {
    // The range is the WHOLE raster's, computed once. Letting -scale
    // work one out per tile stretches each tile over its own local
    // min and max, and neighbouring tiles then disagree about which
    // grey an elevation is: the map draws as a patchwork with a seam
    // on every tile boundary.
    const args = grayscaleArgs(2, 492.7, 1180.5);
    for (const flag of ['-scale_1', '-scale_2', '-scale_3']) {
      const i = args.indexOf(flag);
      expect(args.slice(i + 1, i + 5)).toEqual(['492.7', '1180.5', '0', '255']);
    }
  });

  it('never stretches the alpha band', () => {
    // A tile that is entirely inside the footprint has alpha 255
    // everywhere. Stretched on its own range that becomes 0, and the
    // tile disappears exactly where the data is best.
    const args = grayscaleArgs(2, 492.7, 1180.5);
    const i = args.indexOf('-scale_4');
    expect(args.slice(i + 1, i + 5)).toEqual(['0', '255', '0', '255']);
  });

  it('widens a zero-width range', () => {
    // A flat raster (a constant-value mask, a single-elevation
    // plane) has min === max, and -scale would divide by zero.
    const args = grayscaleArgs(2, 7, 7);
    const i = args.indexOf('-scale_1');
    expect(args.slice(i + 1, i + 5)).toEqual(['7', '8', '0', '255']);
  });

  it('outputs 8-bit in memory', () => {
    const args = grayscaleArgs(2, 0, 1);
    expect(argAfter(args, '-ot')).toBe('Byte');
    expect(argAfter(args, '-of')).toBe('MEM');
  });
});

describe('isValidTileAddress', () => {
  it('accepts addresses inside the pyramid', () => {
    expect(isValidTileAddress(0, 0, 0)).toBe(true);
    expect(isValidTileAddress(14, 4548, 6276)).toBe(true);
    expect(isValidTileAddress(24, 16777215, 16777215)).toBe(true);
  });

  it('rejects an address outside its own zoom level', () => {
    expect(isValidTileAddress(0, 1, 0)).toBe(false);
    expect(isValidTileAddress(1, 0, 2)).toBe(false);
  });

  it('rejects negatives and non-integers', () => {
    expect(isValidTileAddress(-1, 0, 0)).toBe(false);
    expect(isValidTileAddress(3, -1, 0)).toBe(false);
    expect(isValidTileAddress(3.5, 0, 0)).toBe(false);
    expect(isValidTileAddress(3, Number.NaN, 0)).toBe(false);
  });

  it('caps the zoom', () => {
    // This route warps on demand, so a request far past the source's
    // resolution costs a full read for a tile nobody can see, and an
    // uncapped z makes 2 ** z lose integer precision.
    expect(isValidTileAddress(25, 0, 0)).toBe(false);
  });
});

describe('CogTileService.statisticsRange', () => {
  // The service is constructed with dead collaborators because this
  // method touches neither; what is under test is the per-file cache.
  const service = () =>
    new CogTileService(
      {} as ConstructorParameters<typeof CogTileService>[0],
      {} as ConstructorParameters<typeof CogTileService>[1],
    );

  const dataset = (getStatistics: jest.Mock) =>
    ({ bands: { get: () => ({ getStatistics }) } }) as never;

  it('reads a file once, not once per tile', () => {
    // getStatistics is a synchronous native call that blocks the
    // event loop, and the answer is a property of the file. Before
    // the cache it ran on every cache-miss tile of a non-Byte raster.
    const stats = jest.fn(() => ({ min: 492.7, max: 1180.5 }));
    const svc = service();
    const call = () =>
      (svc as never as {
        statisticsRange: (k: string, s: never) => { low: number; high: number };
      }).statisticsRange('item-tile-layer/dem', dataset(stats));
    expect(call()).toEqual({ low: 492.7, high: 1180.5 });
    expect(call()).toEqual({ low: 492.7, high: 1180.5 });
    expect(stats).toHaveBeenCalledTimes(1);
  });

  it('keys the cache by file, not by service', () => {
    const a = jest.fn(() => ({ min: 0, max: 10 }));
    const b = jest.fn(() => ({ min: 5, max: 15 }));
    const svc = service() as never as {
      statisticsRange: (k: string, s: never) => { low: number; high: number };
    };
    expect(svc.statisticsRange('item-tile-layer/a', dataset(a)).high).toBe(10);
    expect(svc.statisticsRange('item-tile-layer/b', dataset(b)).high).toBe(15);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('caches the fallback for a file with no readable statistics', () => {
    // Re-paying a broken statistics read on every tile would repeat
    // the failure; the fallback renders the full Byte range instead.
    const stats = jest.fn(() => {
      throw new Error('no stats');
    });
    const svc = service() as never as {
      statisticsRange: (k: string, s: never) => { low: number; high: number };
    };
    expect(svc.statisticsRange('item-tile-layer/x', dataset(stats))).toEqual({
      low: 0,
      high: 255,
    });
    svc.statisticsRange('item-tile-layer/x', dataset(stats));
    expect(stats).toHaveBeenCalledTimes(1);
  });
});
