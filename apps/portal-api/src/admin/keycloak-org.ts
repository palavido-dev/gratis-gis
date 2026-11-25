// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AuthUser } from '../auth/auth-sync.service.js';
import type { KeycloakUserRep } from './keycloak-admin.service.js';

/**
 * The organization a Keycloak account names in its `org` attribute:
 * the first value, when it is a non-empty string. The portal writes
 * one value; any further values are ignored.
 */
export function keycloakOrgAttribute(account: KeycloakUserRep): string | undefined {
  const arr = account.attributes?.org;
  if (!Array.isArray(arr)) return undefined;
  const first = arr[0];
  return typeof first === 'string' && first.length > 0 ? first : undefined;
}

/**
 * Whether the Keycloak account's `org` attribute names the caller's
 * organization, by its slug or by its id.
 */
export function keycloakAccountInOrg(
  account: KeycloakUserRep,
  org: Pick<AuthUser, 'orgId' | 'orgSlug'>,
): boolean {
  const value = keycloakOrgAttribute(account);
  return value !== undefined && (value === org.orgSlug || value === org.orgId);
}
