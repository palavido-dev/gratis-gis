// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Public-testing mode (PORTAL_LOCK_ADMIN_TIER). On a portal whose
 * admin login is shared, admin-level changes that outlive a password
 * reset (new admins, new sign-in providers, realm-wide sign-in rules)
 * are refused.
 */
export function isAdminTierLocked(): boolean {
  const raw = (process.env.PORTAL_LOCK_ADMIN_TIER ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
