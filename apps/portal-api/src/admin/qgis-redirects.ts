// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Redirect URIs for the public `qgis-plugin` Keycloak client.
 *
 * A trailing `*` matches the rest of the string. `http://127.0.0.1*`
 * therefore also matches a host such as `http://127.0.0.1.example`.
 * `http://127.0.0.1:*` still allows the plugin's loopback listener on
 * any port, and does not match that host. The custom scheme is the
 * preferred callback. Existing extra URIs are kept, except the open
 * wildcard, so a realm that already customized the list is not reset.
 */

export const QGIS_LOOPBACK_REDIRECT = 'http://127.0.0.1:*';
export const QGIS_CUSTOM_SCHEME_REDIRECT = 'gratisgis-qgis://auth-callback';

const OPEN_LOOPBACK = new Set([
  'http://127.0.0.1*',
  'https://127.0.0.1*',
  'http://localhost*',
  'https://localhost*',
]);

export function qgisRedirectUris(current: readonly string[] | undefined): string[] {
  const kept = (current ?? []).filter((uri) => !OPEN_LOOPBACK.has(uri));
  const next = new Set(kept);
  next.add(QGIS_CUSTOM_SCHEME_REDIRECT);
  next.add(QGIS_LOOPBACK_REDIRECT);
  return [...next];
}

export function qgisRedirectsChanged(
  current: readonly string[] | undefined,
): boolean {
  const next = qgisRedirectUris(current);
  const prev = current ?? [];
  if (next.length !== prev.length) return true;
  return next.some((uri, i) => uri !== prev[i]);
}
