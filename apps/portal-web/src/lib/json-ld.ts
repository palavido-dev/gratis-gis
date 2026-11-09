// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Serialize a value for an inline `<script type="application/ld+json">`
 * block.
 *
 * `JSON.stringify` leaves `<`, `>` and `&` alone, so a string value of
 * `</script><script>...` closes the JSON-LD element and the browser
 * runs whatever follows as a normal inline script. The landing page
 * fills JSON-LD from public item titles, descriptions and tags, which
 * any contributor controls, so every JSON-LD block goes through here.
 *
 * Escaping these characters as `\uXXXX` keeps the JSON identical once
 * parsed. U+2028 and U+2029 are escaped too because older JavaScript
 * parsers treat them as line terminators inside string literals.
 */
export function serializeJsonLd(value: unknown): string {
  const json = JSON.stringify(value) ?? 'null';
  return json.replace(/[<>&\u2028\u2029]/g, (ch) => {
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}
