// SPDX-License-Identifier: AGPL-3.0-or-later
import { UnauthorizedException } from '@nestjs/common';

/**
 * Keycloak clients whose access tokens may call portal-api
 * (SEC-jwt-aud). Keycloak does not set `aud` on access tokens by
 * default, so we allowlist `azp` (authorized party / client id)
 * instead of passport-jwt's `audience` option, which would reject
 * every token that omits `aud`.
 *
 * Keep in sync with the Clients table in docs/auth-model.md and the
 * realm templates under infra/keycloak/.
 */
export const DEFAULT_JWT_ALLOWED_AZP: readonly string[] = Object.freeze([
  'portal-web',
  'field-app',
  'qgis-plugin',
]);

/**
 * Parse `JWT_ALLOWED_AZP` (comma-separated client ids). Empty /
 * unset falls back to {@link DEFAULT_JWT_ALLOWED_AZP}. Whitespace
 * around entries is trimmed; empty segments are dropped.
 */
export function parseJwtAllowedAzp(
  raw: string | undefined = process.env.JWT_ALLOWED_AZP,
): ReadonlySet<string> {
  if (raw === undefined || raw.trim() === '') {
    return new Set(DEFAULT_JWT_ALLOWED_AZP);
  }
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return new Set(ids.length > 0 ? ids : DEFAULT_JWT_ALLOWED_AZP);
}

/**
 * Refuse tokens whose `azp` is missing or not on the allowlist.
 * A token from an unknown realm client (or a leaked client that is
 * not one of the portal fronts) must not authenticate to the API.
 */
export function assertAllowedAzp(
  azp: unknown,
  allowed: ReadonlySet<string> = parseJwtAllowedAzp(),
): void {
  if (typeof azp !== 'string' || azp.length === 0 || !allowed.has(azp)) {
    throw new UnauthorizedException('JWT azp is not an allowed client');
  }
}
