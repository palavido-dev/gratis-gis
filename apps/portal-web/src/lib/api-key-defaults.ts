// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Defaults for a new API key on Profile -> API keys. Read only starts
 * ticked: a script that only reads should never hold a key that can
 * write, and the help tells people to leave it ticked.
 */
export const NEW_API_KEY_DEFAULTS = {
  readOnly: true,
  expiryDays: 90 as number | null,
} as const;
