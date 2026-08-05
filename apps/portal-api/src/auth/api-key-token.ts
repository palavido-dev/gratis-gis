// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Token format + hashing for portal API keys (#219).
 *
 * Shape: `ggk_<43 chars of base64url>` = a 4 char scheme marker plus
 * 32 bytes of CSPRNG entropy. The marker exists so three different
 * readers can tell what they are holding without a database lookup:
 * the auth guard (route this to the key path, not the JWT path), a
 * secret scanner (a fixed prefix is greppable), and a human pasting
 * it into a config file.
 *
 * Storage is a SHA-256 hash, never the token, and never reversible
 * encryption. `credential-cipher.ts` exists because those secrets
 * have to be recovered in plaintext to forward upstream; an API key
 * only ever needs to be VERIFIED, so hashing is both sufficient and
 * strictly safer: a database dump yields no working keys.
 *
 * Plain SHA-256 rather than Argon2/bcrypt is deliberate and is only
 * defensible because of the entropy: the token is 256 random bits,
 * so there is no dictionary to attack and no work factor worth
 * paying. It also keeps verification a single indexed lookup rather
 * than a full table scan comparing every row's salted hash.
 */

/** Scheme marker on every issued token. Load-bearing: the auth guard
 *  branches on it, so changing it is a breaking change for every
 *  key already in the wild. */
export const API_KEY_PREFIX = 'ggk_';

/** Bytes of entropy behind the marker. */
const TOKEN_ENTROPY_BYTES = 32;

/**
 * Characters of the token kept in the clear for display ("ggk_A1b2C3d4").
 * Enough to tell two keys apart in a list, far too few to guess the
 * rest: what remains is still 32 bytes of entropy minus 8 base64url
 * characters, i.e. 208 bits.
 */
const DISPLAY_PREFIX_LENGTH = 12;

export interface MintedApiKey {
  /** The full secret. Shown to the user exactly once, never stored. */
  token: string;
  /** SHA-256 of the token, hex. This is what the row stores. */
  tokenHash: string;
  /** Non-secret leading characters, for identifying the key in a list. */
  prefix: string;
}

export function mintApiKey(): MintedApiKey {
  const token =
    API_KEY_PREFIX + randomBytes(TOKEN_ENTROPY_BYTES).toString('base64url');
  return {
    token,
    tokenHash: hashApiKey(token),
    prefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
  };
}

export function hashApiKey(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Whether a presented credential is shaped like one of our keys.
 * Used by the guard to decide between the key path and the JWT path,
 * so it must be cheap and must never throw on hostile input.
 */
export function looksLikeApiKey(value: string): boolean {
  if (!value.startsWith(API_KEY_PREFIX)) return false;
  const body = value.slice(API_KEY_PREFIX.length);
  // 32 bytes base64url-encodes to 43 characters with no padding.
  return body.length === 43 && /^[A-Za-z0-9_-]+$/.test(body);
}

/**
 * Constant-time hash comparison. The lookup is already by hash, so
 * an attacker cannot use timing to walk the key space, but comparing
 * the two hex digests in constant time costs nothing and keeps the
 * property true if the lookup ever changes shape.
 */
export function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * HTTP methods a read-only key is allowed to use.
 *
 * The read-only rule is enforced on the METHOD, not on capabilities,
 * because item write permission in this portal is ownership-based
 * (`SharingService.canEdit`) rather than capability-based: stripping
 * `can_publish_items` from a key would still leave its owner able to
 * overwrite their own layers. A method allowlist is a bright line
 * that can be verified by reading one function, which is what a
 * security property should be.
 *
 * The cost of this choice is that the handful of read endpoints that
 * take POST (search bodies, preview) are unavailable to a read-only
 * key. That is the right side to err on.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isReadOnlySafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}
