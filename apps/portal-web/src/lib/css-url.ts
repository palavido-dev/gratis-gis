// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A CSS `url()` value for an untrusted string, such as an admin-set
 * image URL.
 *
 * Interpolating the raw value as `url(${value})` lets a `)` or `;`
 * close the function and add declarations of its own to the style
 * attribute, and a legitimate URL with a space or a `)` silently
 * breaks. JSON string syntax is valid CSS string syntax for this
 * purpose: the value comes back double quoted, with `"` and `\`
 * escaped and newlines written as escapes, so nothing in it can end
 * the string early.
 */
export function cssUrl(raw: string): string {
  return `url(${JSON.stringify(raw)})`;
}
