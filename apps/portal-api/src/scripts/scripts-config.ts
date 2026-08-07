// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Server-side scripts are opt-in (#221).
 *
 * This is the single read of the flag, shared by the worker entry
 * point (which decides whether to poll) and portal-info (which tells
 * the web app whether to offer the item type). Two independent reads
 * of the same variable is how a portal ends up offering to create
 * items nothing will ever execute.
 *
 * Off by default: running user-authored Python on your own machine
 * should be a decision, not something inherited from an upgrade.
 */
export function isScriptsEnabled(): boolean {
  const v = process.env.PORTAL_SCRIPTS_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
