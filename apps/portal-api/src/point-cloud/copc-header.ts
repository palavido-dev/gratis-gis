// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Minimal COPC/LAS 1.4 header + VLR parser (#179).
 *
 * We only need enough of the format to (a) verify an upload really
 * is COPC before accepting it and (b) lift display metadata (point
 * count, bounds, CRS) onto the item once at finalize time. That is
 * a fixed 375-byte header plus a walk of the variable length
 * records that immediately follow it, all sitting inside the first
 * few KB of the file, so we parse it directly from a ranged read
 * rather than pulling in a full LAS library the API would use for
 * nothing else. The octree hierarchy and the points themselves are
 * never touched server-side; viewers stream those.
 *
 * Layout facts used below (LAS 1.4 spec + copc.io spec):
 *   - Bytes 0-3   file signature "LASF".
 *   - Byte  24/25 version major/minor. COPC requires 1.4.
 *   - Bytes 94/95 header size (375 for 1.4).
 *   - Byte  96    uint32 offset to point data.
 *   - Byte  100   uint32 number of VLRs.
 *   - Byte  104   uint8 point data record format; bit 7 set means
 *                 LAZ-compressed (always set for COPC). Real format
 *                 is the low 6 bits and must be 6, 7, or 8.
 *   - Bytes 131-178 six float64: scale xyz then offset xyz.
 *   - Bytes 179-226 six float64 in max/min PAIRS per axis:
 *                 maxX minX maxY minY maxZ minZ.
 *   - Bytes 247-254 (1.4) uint64 extended point count.
 *   - VLRs start at byte 375. Each: 54-byte header (u16 reserved,
 *     16-byte user id, u16 record id, u16 payload length, 32-byte
 *     description) then the payload.
 *   - COPC requires its `info` VLR (user id "copc", record id 1,
 *     160-byte payload) to be the FIRST VLR, at byte 375.
 *   - WKT CRS lives in user id "LASF_Projection", record id 2112.
 */

export interface CopcHeaderInfo {
  lasVersion: string;
  /** Real point data record format (low 6 bits; 6, 7, or 8). */
  pointFormat: number;
  pointCount: number;
  /** [minX, minY, minZ, maxX, maxY, maxZ] in native CRS. */
  bounds: [number, number, number, number, number, number];
  /** WKT from the LASF_Projection VLR, when present in the parsed
   *  window. */
  crsWkt: string | null;
  hasRgb: boolean;
}

export class CopcParseError extends Error {}

/** How many leading bytes finalize fetches for parsing. The fixed
 *  header is 375 bytes and the VLR section (copc info + laszip +
 *  projection) is typically well under 4 KB; 64 KB gives generous
 *  headroom for files with fat WKT or extra-bytes VLRs. */
export const COPC_PROBE_BYTES = 65536;

const HEADER_SIZE_14 = 375;
const VLR_HEADER_SIZE = 54;

/**
 * Parse and validate the leading bytes of an upload as COPC.
 * Throws CopcParseError with a user-readable message when the file
 * is not COPC; the messages deliberately distinguish "not LAS at
 * all", "LAS but wrong version", and "LAZ but no COPC octree" so
 * the uploader knows whether conversion would help.
 */
export function parseCopcHeader(buf: Buffer): CopcHeaderInfo {
  if (buf.length < HEADER_SIZE_14) {
    throw new CopcParseError('File is too small to be a COPC point cloud.');
  }
  if (buf.toString('latin1', 0, 4) !== 'LASF') {
    throw new CopcParseError(
      'Not a LAS/LAZ file (missing LASF signature). Point cloud items accept COPC (.copc.laz) uploads.',
    );
  }
  const versionMajor = buf.readUInt8(24);
  const versionMinor = buf.readUInt8(25);
  const lasVersion = `${versionMajor}.${versionMinor}`;
  if (versionMajor !== 1 || versionMinor !== 4) {
    throw new CopcParseError(
      `LAS ${lasVersion} file. COPC requires LAS 1.4; convert with: pdal translate input.las output.copc.laz`,
    );
  }
  const headerSize = buf.readUInt16LE(94);
  if (headerSize < HEADER_SIZE_14) {
    throw new CopcParseError('Malformed LAS 1.4 header (header size < 375).');
  }
  const vlrCount = buf.readUInt32LE(100);

  const rawFormat = buf.readUInt8(104);
  const compressed = (rawFormat & 0x80) !== 0;
  const pointFormat = rawFormat & 0x3f;

  // COPC info VLR must be the very first VLR, directly after the
  // header. Checking it before anything else gives the clearest
  // error for plain (non-cloud-optimized) LAZ.
  if (buf.length < headerSize + VLR_HEADER_SIZE) {
    throw new CopcParseError('File ends before the first VLR; not COPC.');
  }
  const firstUserId = readVlrString(buf, headerSize + 2, 16);
  const firstRecordId = buf.readUInt16LE(headerSize + 18);
  if (firstUserId !== 'copc' || firstRecordId !== 1) {
    throw new CopcParseError(
      compressed
        ? 'LAZ file without a COPC octree. Convert with: pdal translate input.laz output.copc.laz'
        : 'Uncompressed LAS file. Convert with: pdal translate input.las output.copc.laz',
    );
  }
  if (pointFormat < 6 || pointFormat > 8) {
    throw new CopcParseError(
      `Point data record format ${pointFormat} is outside the COPC-required 6-8 range; the file violates the COPC spec.`,
    );
  }

  // Extended (64-bit) point count is authoritative in 1.4; the
  // legacy 32-bit field at 107 is zero for large files.
  const pointCount = Number(buf.readBigUInt64LE(247));

  // Max/min pairs per axis (spec order), reshuffled to the
  // conventional [min..., max...] shape.
  const maxX = buf.readDoubleLE(179);
  const minX = buf.readDoubleLE(187);
  const maxY = buf.readDoubleLE(195);
  const minY = buf.readDoubleLE(203);
  const maxZ = buf.readDoubleLE(211);
  const minZ = buf.readDoubleLE(219);

  // Walk the VLR chain for the WKT CRS. Stop cleanly if a VLR
  // extends past the probe window; CRS then stays null rather than
  // failing the upload over metadata.
  let crsWkt: string | null = null;
  let cursor = headerSize;
  for (let i = 0; i < vlrCount; i++) {
    if (cursor + VLR_HEADER_SIZE > buf.length) break;
    const userId = readVlrString(buf, cursor + 2, 16);
    const recordId = buf.readUInt16LE(cursor + 18);
    const payloadLen = buf.readUInt16LE(cursor + 20);
    const payloadStart = cursor + VLR_HEADER_SIZE;
    if (payloadStart + payloadLen > buf.length) break;
    if (userId === 'LASF_Projection' && recordId === 2112) {
      crsWkt = readVlrString(buf, payloadStart, payloadLen);
    }
    cursor = payloadStart + payloadLen;
  }

  return {
    lasVersion,
    pointFormat,
    pointCount,
    bounds: [minX, minY, minZ, maxX, maxY, maxZ],
    crsWkt,
    hasRgb: pointFormat === 7 || pointFormat === 8,
  };
}

/** Read a NUL-padded fixed-width or length-delimited ASCII field. */
function readVlrString(buf: Buffer, start: number, len: number): string {
  const raw = buf.toString('latin1', start, start + len);
  const nul = raw.indexOf('\0');
  return (nul === -1 ? raw : raw.slice(0, nul)).trim();
}
