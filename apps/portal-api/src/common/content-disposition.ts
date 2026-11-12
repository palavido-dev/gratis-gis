// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A Content-Disposition value that is safe for any file name.
 *
 * Node refuses a header value with a character above U+00FF (or a
 * control character) and throws ERR_INVALID_CHAR. A plain
 * `filename="<name>"` therefore failed the whole download with a 500
 * for a macOS screenshot (it puts U+202F before "AM"), a Chinese or
 * Cyrillic name, or a name with a long dash. The RFC 6266 form sends
 * an ASCII fallback in `filename` and the real name, UTF-8 and
 * percent-encoded, in `filename*`, which every current browser
 * prefers.
 */
export function contentDisposition(
  type: 'inline' | 'attachment',
  fileName: string,
): string {
  // Control characters never belong in a file name, and CR or LF
  // would split the header.
  // eslint-disable-next-line no-control-regex
  const cleaned = fileName.replace(/[\u0000-\u001f\u007f]/g, '');
  const fallback =
    cleaned.replace(/["\\]/g, '').replace(/[^\x20-\x7e]/g, '_') || 'download';
  // encodeURIComponent leaves ' ( ) * as is; RFC 5987 wants them encoded.
  const encoded = encodeURIComponent(cleaned).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
