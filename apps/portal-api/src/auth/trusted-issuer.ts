// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Issuers portal-api will accept on an access token.
 *
 * The default is the single KEYCLOAK_URL. A NAS install that signs in
 * on one configured public URL uses that same issuer. AUTH_ALLOWED_ORIGINS
 * (comma-separated portal origins) adds an issuer per origin, using the
 * path prefix from KEYCLOAK_URL (`/auth` on the LAN stack, empty when
 * Keycloak has its own hostname).
 */

export function allowedKeycloakIssuers(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const realm = env.KEYCLOAK_REALM ?? 'gratis-gis';
  const keycloakUrl = (env.KEYCLOAK_URL ?? '').replace(/\/$/, '');
  const configured = keycloakUrl ? `${keycloakUrl}/realms/${realm}` : '';
  const listed = (env.AUTH_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((part) => part.trim().replace(/\/$/, ''))
    .filter(Boolean);
  if (listed.length === 0) return configured ? [configured] : [];
  let prefix = '';
  try {
    prefix = new URL(keycloakUrl || 'http://localhost').pathname.replace(/\/$/, '');
  } catch {
    prefix = '';
  }
  const issuers = listed.map((origin) => `${origin}${prefix}/realms/${realm}`);
  if (configured && !issuers.includes(configured)) issuers.unshift(configured);
  return issuers;
}
