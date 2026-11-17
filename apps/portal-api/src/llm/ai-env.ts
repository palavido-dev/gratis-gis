// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Env flags for AI on public-testing / demo deploys.
 *
 * Looked up per call so a compose restart can flip behavior
 * without rebuilding the image (same pattern as
 * PORTAL_LOCK_ADMIN_TIER).
 */

export function envFlagOn(name: string): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export function envFlagExplicitOff(name: string): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  return raw === '0' || raw === 'false' || raw === 'no' || raw === 'off';
}

/** Same truthy set as AdminUsersController.isAdminTierLocked. */
export function isAdminTierLocked(): boolean {
  return envFlagOn('PORTAL_LOCK_ADMIN_TIER');
}

/**
 * Refuse PUT/DELETE on /api/admin/ai. On when PORTAL_LOCK_AI_CONFIG
 * is truthy, or when the admin tier is locked for public testing
 * unless PORTAL_LOCK_AI_CONFIG is explicitly off.
 */
export function isAiConfigLocked(): boolean {
  if (envFlagExplicitOff('PORTAL_LOCK_AI_CONFIG')) return false;
  if (envFlagOn('PORTAL_LOCK_AI_CONFIG')) return true;
  return isAdminTierLocked();
}

/**
 * Refuse POST /api/ai/build. On when PORTAL_AI_DISABLE_BUILD is
 * truthy, or under public-testing hardening unless that flag is
 * explicitly off (build creates many items and is the costliest
 * AI surface on a shared demo).
 */
export function isAiBuildDisabled(): boolean {
  if (envFlagExplicitOff('PORTAL_AI_DISABLE_BUILD')) return false;
  if (envFlagOn('PORTAL_AI_DISABLE_BUILD')) return true;
  return isAdminTierLocked();
}

/**
 * Parse a non-negative integer env. Null when unset or invalid.
 * Zero means "unlimited" for the daily call caps.
 */
export function parseNonNegIntEnv(name: string): number | null {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

/**
 * Org-wide daily call cap. Unset: 100 under public-testing
 * hardening, otherwise unlimited (0). Explicit 0 disables the cap.
 */
export function orgDailyCallLimit(): number {
  const n = parseNonNegIntEnv('PORTAL_AI_ORG_DAILY_CALL_LIMIT');
  if (n !== null) return n;
  return isAdminTierLocked() ? 100 : 0;
}

/**
 * Per-user daily call cap. Unset: 20 under public-testing
 * hardening, otherwise unlimited (0).
 */
export function userDailyCallLimit(): number {
  const n = parseNonNegIntEnv('PORTAL_AI_USER_DAILY_CALL_LIMIT');
  if (n !== null) return n;
  return isAdminTierLocked() ? 20 : 0;
}

/**
 * Per-user sliding one-minute call cap (in-process). Unset: 6
 * under public-testing hardening, otherwise 12.
 */
export function userMinuteCallLimit(): number {
  const n = parseNonNegIntEnv('PORTAL_AI_USER_MINUTE_CALL_LIMIT');
  if (n !== null) return n;
  return isAdminTierLocked() ? 6 : 12;
}
