// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where an item's stored credential gets sent.
 *
 * The proxy, the ArcGIS copy and the token exchange send the stored
 * credential to `data.url`. PostGIS Live sends the stored password to
 * `data.host` / `port` / `database` as `data.role`. All of those live
 * in `data`, which anyone with edit on the item can PATCH, while
 * setting the credential itself needs admin. So changing the target of
 * an item that has a credential needs admin too; see
 * ItemsService.update.
 *
 * Returns a comparable string, or null when the data names no target.
 */
export function credentialTarget(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const url = typeof d.url === 'string' ? d.url.trim() : null;
  const postgis =
    d.protocol === 'postgis_live'
      ? [d.host, d.port, d.database, d.role].map((v) =>
          typeof v === 'string' ? v.trim().toLowerCase() : v ?? null,
        )
      : null;
  if (!url && !postgis) return null;
  return JSON.stringify({ url, postgis });
}
