// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Credential shape helpers for the MCP server (#219 / Phase 1.5).
 *
 * Portal API keys look like `ggk_<43 base64url chars>`. Session JWTs
 * still work on /api/* today, but they expire in minutes and are a
 * footgun in Claude Desktop / Cursor configs. Soft-detect JWT shape
 * so we can point operators at Profile -> API keys.
 */

export const API_KEY_PREFIX = 'ggk_';

/** Mirror of portal-api looksLikeApiKey: cheap, never throws. */
export function looksLikePortalApiKey(value: string): boolean {
  if (!value.startsWith(API_KEY_PREFIX)) return false;
  const body = value.slice(API_KEY_PREFIX.length);
  return body.length === 43 && /^[A-Za-z0-9_-]+$/.test(body);
}

/**
 * Heuristic for a compact JWT (three base64url segments). Used only
 * to warn; we do not parse or validate the token.
 */
export function looksLikeJwt(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  return parts.every((p) => p.length > 0 && /^[A-Za-z0-9_-]+$/.test(p));
}

export const API_KEY_HOWTO = [
  'Mint a portal API key at Profile -> API keys (token starts with ggk_).',
  'Paste it into GRATIS_GIS_TOKEN. Do not paste a browser session JWT:',
  'those expire in minutes and will break MCP clients mid-session.',
].join('\n');
