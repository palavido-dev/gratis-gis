// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Catalog of every capability the portal recognises. Adding a new
 * capability is a code change here plus a check at the call site;
 * no schema migration needed because per-user overrides store the
 * key as a plain string and validate against this catalog.
 *
 * The catalog lives in shared-types rather than portal-api because
 * `/users/me` serialises the caller's effective set and the web app
 * mirrors server gates from it (`hasCapability` in
 * `apps/portal-web/src/lib/capabilities.ts`). Sharing the union means
 * a typo on either side is a type error instead of a gate that never
 * opens. Role baselines and override merging stay in portal-api: they
 * depend on the Prisma `OrgRole` enum and are never evaluated on the
 * client.
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
