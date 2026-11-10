// SPDX-License-Identifier: AGPL-3.0-or-later
import sharp, { type Metadata } from 'sharp';

/**
 * PNG and JPEG map-icon uploads (#686).
 *
 * The bytes are trusted only after three checks: the file starts with
 * the format's magic number, sharp decodes it as that same format, and
 * its pixel count is under a hard cap checked before decoding. The
 * decoded image is then re-encoded from scratch as a PNG no bigger
 * than RASTER_ICON_MAX_EDGE on its long side. Re-encoding drops every
 * metadata chunk (EXIF, XMP, ICC text, comments) and anything appended
 * after the image data, and keeps the files small so maps stay fast.
 */

export type RasterIconFormat = 'png' | 'jpeg';

/** Upload cap for PNG and JPEG icons. */
export const RASTER_ICON_MAX_BYTES = 2 * 1024 * 1024;

/** Long side of the stored icon, in pixels. */
export const RASTER_ICON_MAX_EDGE = 256;

/**
 * Largest source image we will decode. A small, highly compressed
 * file can declare a huge canvas; sharp refuses to decode past this
 * before allocating the pixel buffer.
 */
export const RASTER_ICON_MAX_INPUT_PIXELS = 4096 * 4096;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/** Identify a PNG or JPEG by its leading bytes. */
export function sniffRasterFormat(buf: Buffer): RasterIconFormat | null {
  if (buf.length >= PNG_MAGIC.length && buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return 'png';
  }
  if (buf.length >= JPEG_MAGIC.length && buf.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) {
    return 'jpeg';
  }
  return null;
}

export type ClaimedIconType = 'svg' | 'raster' | null;

/**
 * What the client says the file is, from its Content-Type and its
 * name. Only a hint for picking the code path: SVG bytes still go
 * through the sanitizer, and raster bytes still have to pass
 * sniffRasterFormat and a real decode.
 */
export function claimedIconType(mimetype: string, fileName: string): ClaimedIconType {
  const mime = (mimetype || '').toLowerCase();
  const name = (fileName || '').toLowerCase();
  if (mime === 'image/svg+xml' || name.endsWith('.svg')) return 'svg';
  if (
    mime === 'image/png' ||
    mime === 'image/jpeg' ||
    mime === 'image/jpg' ||
    /\.(png|jpe?g)$/.test(name)
  ) {
    return 'raster';
  }
  return null;
}

export class RasterIconError extends Error {}

/**
 * Validate and normalize one PNG or JPEG upload. Returns the PNG bytes
 * to store. Throws RasterIconError with a user-facing message when
 * the file is not a real, decodable PNG or JPEG within the limits.
 */
export async function processRasterIcon(input: Buffer): Promise<{
  body: Buffer;
  width: number;
  height: number;
  sourceFormat: RasterIconFormat;
}> {
  if (input.length > RASTER_ICON_MAX_BYTES) {
    throw new RasterIconError('Image is larger than 2 MB.');
  }
  const sniffed = sniffRasterFormat(input);
  if (!sniffed) {
    throw new RasterIconError('File is not a PNG or JPEG image.');
  }
  const opts = {
    limitInputPixels: RASTER_ICON_MAX_INPUT_PIXELS,
    failOn: 'error' as const,
    // Animated PNGs: keep only the first frame.
    pages: 1,
  };
  let meta: Metadata;
  try {
    meta = await sharp(input, opts).metadata();
  } catch {
    throw new RasterIconError('Image could not be read. It may be damaged.');
  }
  if (meta.format !== sniffed) {
    throw new RasterIconError('File contents do not match a PNG or JPEG image.');
  }
  if (!meta.width || !meta.height) {
    throw new RasterIconError('Image has no size.');
  }
  if (meta.width * meta.height > RASTER_ICON_MAX_INPUT_PIXELS) {
    throw new RasterIconError('Image is too large. Use one under 4096 x 4096 pixels.');
  }
  try {
    const { data, info } = await sharp(input, opts)
      // Apply the EXIF orientation before the metadata is dropped,
      // so a phone photo is not stored sideways.
      .rotate()
      .resize({
        width: RASTER_ICON_MAX_EDGE,
        height: RASTER_ICON_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });
    return { body: data, width: info.width, height: info.height, sourceFormat: sniffed };
  } catch {
    throw new RasterIconError('Image could not be processed. It may be damaged.');
  }
}
