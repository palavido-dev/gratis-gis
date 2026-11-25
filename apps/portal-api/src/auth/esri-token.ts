// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Tokens for Esri clients (ArcGIS Pro, QGIS), minted by the
 * FeatureServer's generateToken from a personal API key.
 *
 * `ggesri.<claims>.<mac>`. The claims name the API key by id and carry
 * an expiry; nothing secret is inside. Every request that presents
 * one resolves the key again, so revoking or expiring the key, or
 * disabling its owner, stops its tokens at once.
 */

export const ESRI_TOKEN_PREFIX = 'ggesri.';
export const ESRI_TOKEN_KEY_LABEL = 'esri-token-v1';
/** Longest life a token is given, in minutes. Clients ask again. */
export const ESRI_TOKEN_MAX_MINUTES = 60;

const MAX_LENGTH = 1024;

export interface EsriTokenClaims {
  /** ApiKey row id. */
  kid: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

function mac(key: Buffer, body: string): Buffer {
  return createHmac('sha256', key).update(`esri-token.v1.${body}`).digest();
}

export function signEsriToken(claims: EsriTokenClaims, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${ESRI_TOKEN_PREFIX}${body}.${mac(key, body).toString('base64url')}`;
}

export function looksLikeEsriToken(value: string): boolean {
  return value.length <= MAX_LENGTH && /^ggesri\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

export function verifyEsriToken(value: unknown, key: Buffer, now = Date.now()): EsriTokenClaims | null {
  if (typeof value !== 'string' || !looksLikeEsriToken(value)) return null;
  const rest = value.slice(ESRI_TOKEN_PREFIX.length);
  const dot = rest.indexOf('.');
  const body = rest.slice(0, dot);
  const given = Buffer.from(rest.slice(dot + 1), 'base64url');
  const expected = mac(key, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const c = parsed as Partial<EsriTokenClaims> | null;
  if (!c || typeof c.kid !== 'string' || typeof c.exp !== 'number') return null;
  if (c.exp < now) return null;
  return { kid: c.kid, exp: c.exp };
}

/**
 * The Esri token a request carries, if it is one of ours or claims to
 * be a token at all: the `token` parameter (query or form body) or an
 * `X-Esri-Authorization: Bearer` header. Undefined when there is none.
 */
export function presentedEsriToken(req: {
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, unknown>;
}): string | undefined {
  const pick = (v: unknown): string | undefined => {
    const one = Array.isArray(v) ? v[0] : v;
    return typeof one === 'string' && one.length > 0 ? one : undefined;
  };
  const header = pick(req.headers?.['x-esri-authorization']);
  if (header) {
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    if (m) return m[1];
  }
  const fromQuery = pick(req.query?.token);
  if (fromQuery) return fromQuery;
  const body = req.body as Record<string, unknown> | undefined;
  return body && typeof body === 'object' ? pick(body.token) : undefined;
}
