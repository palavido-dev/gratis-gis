// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CapabilityKey } from '@gratis-gis/shared-types';

/**
 * The slice of `/api/users/me` a capability check needs. Pages type
 * their `me` fetch inline, so this is a structural type rather than a
 * full response model: any object carrying `capabilities` qualifies.
 */
export interface CapabilityBearer {
  /**
   * Effective capability keys, serialised by `/users/me` from the
   * server's `AuthUser.capabilities` set (role baseline plus per-user
   * overrides). Optional so a caller that could not load `me` at all
   * (the field page's anonymous fallback) fails closed instead of
   * failing to compile.
   */
  capabilities?: readonly string[] | null;
}

/**
 * Web mirror of portal-api's `hasCapability`. Use this, not
 * `orgRole !== 'viewer'`, wherever the UI is deciding whether to
 * offer an action the API gates on a capability: the role comparison
 * ignores `user_capability_override` rows, so a viewer granted
 * `can_publish_items` saw no New button and a contributor with it
 * revoked filled in a whole form to collect a 403.
 *
 * This is a courtesy mirror. The enforcement is the server check, so
 * a missing or malformed list reads as "not granted" rather than as
 * an error.
 */
export function hasCapability(
  me: CapabilityBearer,
  key: CapabilityKey,
): boolean {
  return Array.isArray(me.capabilities) && me.capabilities.includes(key);
}
