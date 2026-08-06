// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Identify an image by its leading bytes.
 *
 * The feedback endpoint is public and unauthenticated by design, so
 * the declared Content-Type on an upload is an attacker-supplied
 * string and cannot gate anything. Sniffing the actual bytes is what
 * stops the screenshot field from becoming general-purpose file
 * hosting on somebody else's server.
 *
 * Hand-rolled rather than pulling in `file-type`: this needs to
 * recognise four formats from their first sixteen bytes, and the
 * repo's standing preference is a small helper over a dependency
 * tree. The formats match the ones object storage already accepts
 * for thumbnails and avatars.
 *
 * SVG is deliberately absent. It is a document format that executes
 * script, has no magic number to sniff, and would have to be
 * sanitized rather than merely identified. A reporter attaching a
 * screenshot never needs it.
 */
export type SniffedImage = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export function sniffImage(buf: Buffer): SniffedImage | null {
  if (buf.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }

  // JPEG: FF D8 FF. (The fourth byte varies by encoder marker.)
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }

  // GIF: "GIF87a" or "GIF89a"
  if (buf.subarray(0, 6).toString('latin1').match(/^GIF8[79]a$/)) {
    return 'image/gif';
  }

  // WebP is RIFF-framed: "RIFF" <4-byte size> "WEBP". Both markers
  // are checked because "RIFF" alone also covers WAV and AVI.
  if (
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}
