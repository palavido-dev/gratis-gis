// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * PortalInfo: the discovery document a portal serves to clients that
 * need to bootstrap themselves with one URL.
 *
 * Returned by `GET /api/portal-info` (unauthenticated). External
 * clients (the QGIS plugin, the mobile field app, future SDKs) hit
 * this endpoint with just the portal URL the user typed and read
 * everything they need to configure themselves: the OIDC issuer for
 * sign-in, the API base for subsequent calls, and a display name for
 * the connection.
 *
 * The portal does NOT return per-client OIDC client IDs here. Each
 * client knows its own client_id by virtue of being that client
 * (the QGIS plugin uses "qgis-plugin", the field app uses
 * "field-app", and so on). This keeps the discovery contract small
 * and prevents clients from impersonating each other by reading a
 * client_id off the wire.
 */
export interface PortalInfo {
  /**
   * Human-readable portal name, suitable for showing in a "Connect
   * to..." UI. Falls back to the host portion of the portal URL when
   * the deployment has not configured a name.
   */
  name: string;

  /**
   * Portal version string, mirrored from portal-api's package.json.
   * Useful for clients that want to surface "minimum supported
   * portal version: X" upgrade messages.
   */
  version: string;

  api: {
    /**
     * Fully-qualified base URL for portal-api calls. Clients should
     * use this rather than appending /api to the portal URL the user
     * typed, because deployments may split the API host from the web
     * host (e.g. api.example.org vs app.example.org).
     */
    baseUrl: string;
  };

  auth: {
    /**
     * OIDC authentication. Today this is always 'oidc' (against the
     * portal's bundled Keycloak realm). The literal is part of the
     * contract so future auth backends (Authentik, Auth0, dex) can
     * extend the union without breaking existing readers.
     */
    type: 'oidc';

    /**
     * OIDC issuer URL. Clients should construct the discovery URL
     * by appending /.well-known/openid-configuration to this value.
     * For the bundled deployment this is
     * `{KEYCLOAK_URL}/realms/{KEYCLOAK_REALM}`.
     */
    issuer: string;
  };

  /**
   * Optional capabilities this portal has switched on. Absent members
   * mean "off", so a client reading a portal that predates a given
   * feature behaves the same as one reading a portal that has it
   * disabled, without needing a version comparison.
   *
   * This is the single source of truth for the web app too: the
   * alternative was a matching NEXT_PUBLIC_ variable on the frontend,
   * which is two settings an operator has to keep in agreement and
   * one they can get wrong in a way that shows a button leading to a
   * disabled endpoint.
   */
  features?: {
    /**
     * In-portal feedback form (PORTAL_FEEDBACK_ENABLED). Off by
     * default: enabling it opens a public, unauthenticated write
     * endpoint, which should be a deliberate choice rather than
     * something an upgrade turns on.
     */
    feedback?: boolean;

    /**
     * Server-side scripts (PORTAL_SCRIPTS_ENABLED, #221). Off by
     * default: this is the one feature that executes code the portal
     * did not write, so it is turned on deliberately or not at all.
     */
    scripts?: boolean;
  };
}
