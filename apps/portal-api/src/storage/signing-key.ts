// SPDX-License-Identifier: AGPL-3.0-or-later
import { hkdfSync } from 'node:crypto';

/**
 * A key for signing values that only this server should mint. Derived
 * from a server secret with HKDF under a per-purpose label, so the raw
 * secret is never used directly and two purposes never share a key.
 * Upload handles and the print read credential pass the MinIO secret.
 * Esri client tokens pass GRATIS_SIGNING_SECRET (see
 * auth/esri-signing-secret.ts), because a secret that storage and
 * other services also hold should not be able to sign in as a user.
 * Kept apart from StorageService so the auth layer can use it without
 * depending on the storage module.
 */
export function deriveServerSigningKey(secret: string, label: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'gratis-gis', label, 32));
}
