// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Identifier for a layer the browser creates before the server sees it.
 *
 * `crypto.randomUUID` exists only in a secure context. A NAS install is
 * opened as `http://192.168.x.x:8080`, which is not one, so the method
 * is missing and calling it throws before the create request is sent.
 * The Add layer dialog then has no response to explain and can only
 * show the generic sentence. `getRandomValues` is available on that
 * same page, so the id is built from those bytes instead.
 */
export function clientUuid(): string {
  const webcrypto = globalThis.crypto;
  if (webcrypto && typeof webcrypto.randomUUID === 'function') {
    return webcrypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (webcrypto && typeof webcrypto.getRandomValues === 'function') {
    webcrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
