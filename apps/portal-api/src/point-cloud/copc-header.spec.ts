// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CopcParseError,
  parseCopcHeader,
} from './copc-header.js';

/**
 * The parser is exercised against synthetic buffers built from the
 * same offsets the LAS 1.4 + COPC specs define, constructed by an
 * independent builder below rather than by the parser's own
 * constants, so an offset mistake in the parser cannot cancel out
 * in the tests.
 */

interface BuildOptions {
  signature?: string;
  versionMajor?: number;
  versionMinor?: number;
  pointFormat?: number; // raw byte incl. compression bit
  pointCount?: bigint;
  bounds?: {
    minX: number; maxX: number;
    minY: number; maxY: number;
    minZ: number; maxZ: number;
  };
  /** VLRs in order. First should be copc info for a valid file. */
  vlrs?: Array<{ userId: string; recordId: number; payload: Buffer }>;
}

function buildLas(opts: BuildOptions = {}): Buffer {
  const {
    signature = 'LASF',
    versionMajor = 1,
    versionMinor = 4,
    pointFormat = 0x80 | 6, // compressed + pdrf 6
    pointCount = 1234567n,
    bounds = {
      minX: 589000, maxX: 590999.99,
      minY: 4319000, maxY: 4320999.99,
      minZ: 120.5, maxZ: 980.25,
    },
    vlrs = [copcInfoVlr()],
  } = opts;

  const header = Buffer.alloc(375);
  header.write(signature, 0, 'latin1');
  header.writeUInt8(versionMajor, 24);
  header.writeUInt8(versionMinor, 25);
  header.writeUInt16LE(375, 94); // header size
  header.writeUInt32LE(375, 96); // offset to point data (fake)
  header.writeUInt32LE(vlrs.length, 100);
  header.writeUInt8(pointFormat, 104);
  // Max/min pairs per axis, spec order.
  header.writeDoubleLE(bounds.maxX, 179);
  header.writeDoubleLE(bounds.minX, 187);
  header.writeDoubleLE(bounds.maxY, 195);
  header.writeDoubleLE(bounds.minY, 203);
  header.writeDoubleLE(bounds.maxZ, 211);
  header.writeDoubleLE(bounds.minZ, 219);
  header.writeBigUInt64LE(pointCount, 247);

  const vlrBufs = vlrs.map(({ userId, recordId, payload }) => {
    const vh = Buffer.alloc(54);
    vh.write(userId, 2, 'latin1');
    vh.writeUInt16LE(recordId, 18);
    vh.writeUInt16LE(payload.length, 20);
    return Buffer.concat([vh, payload]);
  });
  return Buffer.concat([header, ...vlrBufs]);
}

function copcInfoVlr() {
  return { userId: 'copc', recordId: 1, payload: Buffer.alloc(160) };
}

function wktVlr(wkt: string) {
  return {
    userId: 'LASF_Projection',
    recordId: 2112,
    payload: Buffer.from(`${wkt}\0`, 'latin1'),
  };
}

describe('parseCopcHeader', () => {
  it('accepts a valid COPC header and lifts the metadata', () => {
    const wkt = 'PROJCS["NAD83 / UTM zone 17N",GEOGCS["NAD83"]]';
    const buf = buildLas({ vlrs: [copcInfoVlr(), wktVlr(wkt)] });
    const info = parseCopcHeader(buf);
    expect(info.lasVersion).toBe('1.4');
    expect(info.pointFormat).toBe(6);
    expect(info.hasRgb).toBe(false);
    expect(info.pointCount).toBe(1234567);
    expect(info.bounds).toEqual([
      589000, 4319000, 120.5, 590999.99, 4320999.99, 980.25,
    ]);
    expect(info.crsWkt).toBe(wkt);
  });

  it('reports RGB for point formats 7 and 8', () => {
    for (const pdrf of [7, 8]) {
      const info = parseCopcHeader(buildLas({ pointFormat: 0x80 | pdrf }));
      expect(info.pointFormat).toBe(pdrf);
      expect(info.hasRgb).toBe(true);
    }
  });

  it('leaves crsWkt null when no projection VLR exists', () => {
    const info = parseCopcHeader(buildLas());
    expect(info.crsWkt).toBeNull();
  });

  it('rejects non-LAS bytes', () => {
    expect(() =>
      parseCopcHeader(Buffer.alloc(1024).fill(0x50)),
    ).toThrow(/missing LASF signature/);
  });

  it('rejects tiny files without throwing range errors', () => {
    expect(() => parseCopcHeader(Buffer.from('LASF'))).toThrow(
      CopcParseError,
    );
  });

  it('rejects pre-1.4 LAS with a version-specific message', () => {
    expect(() => parseCopcHeader(buildLas({ versionMinor: 2 }))).toThrow(
      /LAS 1\.2.*pdal translate/,
    );
  });

  it('rejects plain LAZ (no copc info VLR first) with a conversion hint', () => {
    const buf = buildLas({
      vlrs: [
        { userId: 'laszip encoded', recordId: 22204, payload: Buffer.alloc(52) },
      ],
    });
    expect(() => parseCopcHeader(buf)).toThrow(/without a COPC octree/);
  });

  it('rejects uncompressed LAS with its own message', () => {
    const buf = buildLas({
      pointFormat: 6, // compression bit clear
      vlrs: [
        { userId: 'LASF_Projection', recordId: 2112, payload: Buffer.alloc(8) },
      ],
    });
    expect(() => parseCopcHeader(buf)).toThrow(/Uncompressed LAS/);
  });

  it('rejects COPC-invalid point formats', () => {
    const buf = buildLas({ pointFormat: 0x80 | 3 });
    expect(() => parseCopcHeader(buf)).toThrow(/6-8 range/);
  });

  it('survives a WKT VLR truncated by the probe window', () => {
    const buf = buildLas({ vlrs: [copcInfoVlr(), wktVlr('X'.repeat(500))] });
    // Chop mid-payload of the second VLR.
    const truncated = buf.subarray(0, 375 + 54 + 160 + 54 + 10);
    const info = parseCopcHeader(truncated);
    expect(info.crsWkt).toBeNull();
    expect(info.pointCount).toBe(1234567);
  });
});
