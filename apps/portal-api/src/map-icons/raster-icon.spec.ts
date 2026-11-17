// SPDX-License-Identifier: AGPL-3.0-or-later
import sharp from 'sharp';

import {
  RASTER_ICON_MAX_BYTES,
  RASTER_ICON_MAX_EDGE,
  RasterIconError,
  claimedIconType,
  processRasterIcon,
  sniffRasterFormat,
} from './raster-icon.js';

function solid(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } },
  });
}

describe('sniffRasterFormat', () => {
  it('recognizes PNG and JPEG by their leading bytes', async () => {
    expect(sniffRasterFormat(await solid(4, 4).png().toBuffer())).toBe('png');
    expect(sniffRasterFormat(await solid(4, 4).jpeg().toBuffer())).toBe('jpeg');
  });

  it('rejects anything else, including short buffers', () => {
    expect(sniffRasterFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffRasterFormat(Buffer.from('GIF89a'))).toBeNull();
    expect(sniffRasterFormat(Buffer.from([0x89, 0x50]))).toBeNull();
    expect(sniffRasterFormat(Buffer.alloc(0))).toBeNull();
  });
});

describe('claimedIconType', () => {
  it('routes by content type or file name', () => {
    expect(claimedIconType('image/svg+xml', 'x')).toBe('svg');
    expect(claimedIconType('application/octet-stream', 'Pin.SVG')).toBe('svg');
    expect(claimedIconType('image/png', 'x')).toBe('raster');
    expect(claimedIconType('image/jpeg', 'x')).toBe('raster');
    expect(claimedIconType('', 'photo.JPEG')).toBe('raster');
    expect(claimedIconType('', 'photo.jpg')).toBe('raster');
  });

  it('refuses other types', () => {
    expect(claimedIconType('image/gif', 'a.gif')).toBeNull();
    expect(claimedIconType('image/webp', 'a.webp')).toBeNull();
    expect(claimedIconType('text/html', 'a.html')).toBeNull();
  });
});

describe('processRasterIcon', () => {
  it('re-encodes a PNG and keeps a small one at its size', async () => {
    const out = await processRasterIcon(await solid(64, 32).png().toBuffer());
    expect(sniffRasterFormat(out.body)).toBe('png');
    expect([out.width, out.height]).toEqual([64, 32]);
    expect(out.sourceFormat).toBe('png');
  });

  it('converts a JPEG to PNG', async () => {
    const out = await processRasterIcon(await solid(40, 40).jpeg().toBuffer());
    expect(sniffRasterFormat(out.body)).toBe('png');
    expect(out.sourceFormat).toBe('jpeg');
  });

  it('downscales the long side to the icon cap and keeps the aspect ratio', async () => {
    const out = await processRasterIcon(await solid(1024, 512).png().toBuffer());
    expect(out.width).toBe(RASTER_ICON_MAX_EDGE);
    expect(out.height).toBe(RASTER_ICON_MAX_EDGE / 2);
    const meta = await sharp(out.body).metadata();
    expect([meta.width, meta.height]).toEqual([out.width, out.height]);
  });

  it('strips metadata', async () => {
    const input = await solid(32, 32)
      .withExif({ IFD0: { Copyright: 'secret-owner', Artist: 'someone' } })
      .jpeg()
      .toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const out = await processRasterIcon(input);
    const meta = await sharp(out.body).metadata();
    expect(meta.exif).toBeUndefined();
    expect(out.body.includes(Buffer.from('secret-owner'))).toBe(false);
  });

  it('applies EXIF orientation before dropping it', async () => {
    // 60 x 20 stored, orientation 6 means "rotate 90 degrees to view".
    const input = await solid(60, 20).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const out = await processRasterIcon(input);
    expect([out.width, out.height]).toEqual([20, 60]);
  });

  it('rejects a file whose bytes are not PNG or JPEG', async () => {
    await expect(
      processRasterIcon(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),
    ).rejects.toThrow(RasterIconError);
    await expect(
      processRasterIcon(await solid(8, 8).gif().toBuffer()),
    ).rejects.toThrow('not a PNG or JPEG');
  });

  it('rejects a PNG signature on bytes that do not decode', async () => {
    const fake = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('this is not really a png'),
    ]);
    await expect(processRasterIcon(fake)).rejects.toThrow(RasterIconError);
  });

  it('rejects a truncated image', async () => {
    const png = await solid(64, 64).png().toBuffer();
    await expect(
      processRasterIcon(png.subarray(0, Math.floor(png.length / 2))),
    ).rejects.toThrow(RasterIconError);
  });

  it('rejects a file over the byte cap before decoding', async () => {
    const big = Buffer.alloc(RASTER_ICON_MAX_BYTES + 1);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await expect(processRasterIcon(big)).rejects.toThrow('larger than 2 MB');
  });

  it('rejects an image with too many pixels', async () => {
    // A blank 5000 x 5000 PNG compresses to a few KB, which is the
    // case the pixel cap exists for.
    const huge = await sharp({
      create: { width: 5000, height: 5000, channels: 3, background: '#fff' },
    })
      .png()
      .toBuffer();
    expect(huge.length).toBeLessThan(RASTER_ICON_MAX_BYTES);
    await expect(processRasterIcon(huge)).rejects.toThrow(RasterIconError);
  });

  it('ignores bytes appended after the image', async () => {
    const png = await solid(16, 16).png().toBuffer();
    const tail = Buffer.from('<script>alert(1)</script>');
    const out = await processRasterIcon(Buffer.concat([png, tail]));
    expect(out.body.includes(tail)).toBe(false);
  });
});
