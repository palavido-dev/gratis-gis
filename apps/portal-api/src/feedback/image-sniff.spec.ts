// SPDX-License-Identifier: AGPL-3.0-or-later
import { sniffImage } from './image-sniff.js';

/** Build a buffer from magic bytes plus filler, so length checks pass. */
function withMagic(...bytes: number[]): Buffer {
  return Buffer.concat([Buffer.from(bytes), Buffer.alloc(32)]);
}

describe('sniffImage', () => {
  it('recognises PNG', () => {
    expect(sniffImage(withMagic(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(
      'image/png',
    );
  });

  it('recognises JPEG regardless of the encoder marker', () => {
    // The 4th byte varies (E0 = JFIF, E1 = Exif, DB = raw tables).
    for (const marker of [0xe0, 0xe1, 0xdb, 0xee]) {
      expect(sniffImage(withMagic(0xff, 0xd8, 0xff, marker))).toBe('image/jpeg');
    }
  });

  it('recognises both GIF versions', () => {
    expect(sniffImage(Buffer.concat([Buffer.from('GIF87a'), Buffer.alloc(32)]))).toBe(
      'image/gif',
    );
    expect(sniffImage(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(32)]))).toBe(
      'image/gif',
    );
  });

  it('recognises WebP', () => {
    const buf = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from('WEBP'),
      Buffer.alloc(32),
    ]);
    expect(sniffImage(buf)).toBe('image/webp');
  });

  it('rejects RIFF containers that are not WebP', () => {
    // "RIFF" alone also opens WAV and AVI. Accepting on the first
    // four bytes would let an audio or video file through as an image.
    const wav = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from('WAVE'),
      Buffer.alloc(32),
    ]);
    expect(sniffImage(wav)).toBeNull();
  });

  // The endpoint is public and the declared Content-Type is
  // attacker-supplied, so these are the cases that matter.
  it.each([
    ['a PDF', '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n'],
    ['an SVG, which is a script-bearing document', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ['an HTML page', '<!DOCTYPE html><html><body>hi</body></html>'],
    ['a shell script', '#!/bin/sh\nrm -rf /\n'],
    ['a ZIP archive', 'PK\x03\x04................'],
    ['plain text', 'this is not an image at all, not even close'],
  ])('rejects %s', (_label, content) => {
    expect(sniffImage(Buffer.from(content, 'latin1'))).toBeNull();
  });

  it('rejects an ELF binary renamed to .png', () => {
    expect(sniffImage(withMagic(0x7f, 0x45, 0x4c, 0x46))).toBeNull();
  });

  it('rejects buffers too short to identify', () => {
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e]))).toBeNull();
    // A truncated PNG signature is not a PNG.
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBeNull();
  });
});
