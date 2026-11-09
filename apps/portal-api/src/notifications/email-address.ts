// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A bare `local@domain` address and nothing else: no display name, no
 * angle brackets, no whitespace and no CR/LF. Recipient strings end up
 * inside SMTP command lines and headers, so anything looser lets a
 * form author smuggle extra commands or headers into the session.
 */
const PLAIN_ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function isPlainEmailAddress(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && PLAIN_ADDRESS.test(value);
}

/** True when a value would break out of one SMTP line. */
export function hasLineBreak(value: string): boolean {
  return /[\r\n\0]/.test(value);
}
