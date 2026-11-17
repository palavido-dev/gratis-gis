// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The pyramid worker's legacy COG download is only for an object
 * that already lives in this install's own storage. A tile layer's
 * JSON can carry a URL. That URL is fetched only when its host is
 * the configured MinIO endpoint or public base. Anything else is
 * refused, including a URL that points at another service on the
 * docker network. Rows that have a storage key never use this path.
 */

export function storageBasesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const keys = ['MINIO_PUBLIC_BASE', 'MINIO_ENDPOINT', 'S3_ENDPOINT'] as const;
  const out: string[] = [];
  for (const key of keys) {
    const value = env[key];
    if (typeof value === 'string' && value.trim().length > 0) out.push(value.trim());
  }
  return out;
}

export function isOwnStorageUrl(raw: string, bases: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  for (const base of bases) {
    let parsed: URL;
    try {
      parsed = new URL(base);
    } catch {
      continue;
    }
    if (parsed.protocol === url.protocol && parsed.host === url.host) return true;
  }
  return false;
}
