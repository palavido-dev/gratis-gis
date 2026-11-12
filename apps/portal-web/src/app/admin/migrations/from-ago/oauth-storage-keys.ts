// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * sessionStorage keys shared between the OAuth opener (the
 * importer view) and the popup (the oauth-callback page).
 *
 * Lives outside both /oauth-callback/page.tsx and from-ago-view.tsx
 * because Next.js page files are only allowed to export the default
 * component (plus a small allowlist of named exports like
 * `metadata`); any other named export fails the page-shape check
 * at build time.
 *
 * The opener writes `gratisgis.ago-oauth-state` before opening the
 * popup; the callback reads + verifies + removes it. The
 * sharing-base and org-url keys are auxiliary so the opener can
 * round-trip the canonical URL and the original user-typed URL
 * without re-deriving them after the popup returns.
 */

/** CSRF token round-tripped across the OAuth popup. */
export const STATE_STORAGE_KEY = 'gratisgis.ago-oauth-state';

/** Canonical /sharing/rest base the popup signed in against. */
export const SHARING_BASE_STORAGE_KEY = 'gratisgis.ago-oauth-sharing-base';

/** Whatever URL shape the user originally typed; shown in the
 *  "Connected to ArcGIS Online" panel after sign-in. */
export const ORG_URL_STORAGE_KEY = 'gratisgis.ago-oauth-org-url';

/**
 * Name of the BroadcastChannel the OAuth callback page uses to
 * deliver the captured token to the opener. Same-origin only:
 * BroadcastChannel inherently scopes to the origin. The popup
 * checks the state token against the callback, and each opener tab
 * accepts only a payload carrying the state token it stored for a
 * sign-in it still has pending.
 *
 * BroadcastChannel survives the cross-origin navigation through
 * AGO that severs window.opener under modern COOP defaults
 * (especially in Edge / Chrome).
 */
export const TOKEN_CHANNEL_NAME = 'gratisgis.ago-oauth-token-channel';
