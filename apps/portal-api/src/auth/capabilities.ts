import type { OrgRole } from '@prisma/client';

import type { AuthUser } from './auth-sync.service.js';

/**
 * Catalog of every capability the portal recognises. Adding a new
 * capability is a code change here plus a check at the call site;
 * no schema migration needed because per-user overrides store the
 * key as a plain string and validate against this catalog.
 *
 * Naming convention: `can_<verb>_<noun>`. Keep verbs short and
 * concrete (manage, view, edit, disable, run). The noun is whatever
 * the capability gates: a resource, a surface, an action.
 */
export const CAPABILITY_KEYS = [
  'can_view_public_items',
  'can_publish_items',
  'can_share_items',
  'can_edit_own_items',
  'can_edit_any_item',
  'can_manage_users',
  'can_edit_branding',
  'can_manage_basemaps',
  'can_disable_users',
  'can_run_housekeeping',
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export function isCapabilityKey(value: unknown): value is CapabilityKey {
  return (
    typeof value === 'string' &&
    (CAPABILITY_KEYS as readonly string[]).includes(value)
  );
}

/**
 * Each role's baseline capability set. Per-user overrides (stored in
 * the `user_capability_override` table) layer on top. Baselines live
 * in code rather than the DB so a capability catalog change is a
 * code review instead of an admin SQL operation.
 *
 * The `admin` baseline includes everything the legacy `orgRole ===
 * 'admin'` checks gated; the migration to `hasCapability(...)` at
 * each call site happens incrementally as we touch each guard.
 */
export const ROLE_BASELINES: Record<OrgRole, ReadonlySet<CapabilityKey>> = {
  viewer: new Set<CapabilityKey>([
    'can_view_public_items',
  ]),
  contributor: new Set<CapabilityKey>([
    'can_view_public_items',
    'can_publish_items',
    'can_share_items',
    'can_edit_own_items',
  ]),
  admin: new Set<CapabilityKey>([
    'can_view_public_items',
    'can_publish_items',
    'can_share_items',
    'can_edit_own_items',
    'can_edit_any_item',
    'can_manage_users',
    'can_edit_branding',
    'can_manage_basemaps',
    'can_disable_users',
    'can_run_housekeeping',
  ]),
};

/**
 * One per-user override row, as the service layer thinks of it.
 */
export interface CapabilityOverride {
  capability: CapabilityKey;
  enabled: boolean;
  note: string | null;
  grantedBy: string;
  grantedAt: Date;
}

/**
 * Compute the user's effective capability set: start with the role
 * baseline, layer overrides on top (grants add, revokes remove).
 * Unknown capability keys in overrides are ignored so a stale
 * override (one whose capability has been removed from the catalog)
 * doesn't crash the request path.
 */
export function effectiveCapabilities(
  role: OrgRole,
  overrides: readonly { capability: string; enabled: boolean }[],
): Set<CapabilityKey> {
  const result = new Set<CapabilityKey>(ROLE_BASELINES[role]);
  for (const o of overrides) {
    if (!isCapabilityKey(o.capability)) continue;
    if (o.enabled) result.add(o.capability);
    else result.delete(o.capability);
  }
  return result;
}

/**
 * Read-side helper for guards and service-layer checks. Returns
 * whether the user is granted the named capability, factoring in
 * both the role baseline and any per-user overrides (already
 * computed into `user.capabilities` by AuthSyncService).
 *
 * Prefer this over `user.orgRole === 'admin'` at any call site
 * where the action being gated is a specific capability. Keep raw
 * role checks where role itself is the right abstraction (e.g.
 * AdminGuard's "is this user an admin at all").
 */
export function hasCapability(
  user: AuthUser,
  capability: CapabilityKey,
): boolean {
  return user.capabilities.has(capability);
}
