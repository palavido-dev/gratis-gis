// SPDX-License-Identifier: AGPL-3.0-or-later
import { hkdfSync } from 'node:crypto';

/**
 * A key for signing values that only this server should mint. Derived
 * from the MinIO secret with HKDF under a per-purpose label, so the
 * raw secret is never used directly and two purposes never share a
 * key. Every install already sets MINIO_SECRET_KEY, so no new setting
 * is needed. Kept apart from StorageService so the auth layer can use
 * it without depending on the storage module.
 */
export function deriveServerSigningKey(secret: string, label: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'gratis-gis', label, 32));
}
