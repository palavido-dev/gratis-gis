// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  API_KEY_PREFIX,
  hashApiKey,
  hashesMatch,
  isReadOnlySafeMethod,
  looksLikeApiKey,
  mintApiKey,
} from './api-key-token.js';

describe('mintApiKey', () => {
  it('mints a marked, high-entropy token with a matching hash', () => {
    const k = mintApiKey();
    expect(k.token.startsWith(API_KEY_PREFIX)).toBe(true);
    // 4 char marker + 43 chars of base64url over 32 bytes.
    expect(k.token).toHaveLength(47);
    expect(k.tokenHash).toBe(hashApiKey(k.token));
    expect(k.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never repeats', () => {
    const seen = new Set(
      Array.from({ length: 200 }, () => mintApiKey().token),
    );
    expect(seen.size).toBe(200);
  });

  it('exposes a display prefix that is a strict prefix of the token', () => {
    const k = mintApiKey();
    expect(k.prefix).toHaveLength(12);
    expect(k.token.startsWith(k.prefix)).toBe(true);
    // The stored prefix must not be enough to reconstruct the secret.
    expect(k.prefix.length).toBeLessThan(k.token.length / 2);
  });
});

describe('looksLikeApiKey', () => {
  it('accepts freshly minted tokens', () => {
    for (let i = 0; i < 50; i++) {
      expect(looksLikeApiKey(mintApiKey().token)).toBe(true);
    }
  });

  it('rejects JWTs, empty strings, and near-misses', () => {
    const jwt =
      'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.sig';
    expect(looksLikeApiKey(jwt)).toBe(false);
    expect(looksLikeApiKey('')).toBe(false);
    expect(looksLikeApiKey(API_KEY_PREFIX)).toBe(false);
    // Right marker, wrong length.
    expect(looksLikeApiKey(`${API_KEY_PREFIX}tooshort`)).toBe(false);
    // Right length, characters outside the base64url alphabet.
    expect(looksLikeApiKey(`${API_KEY_PREFIX}${'!'.repeat(43)}`)).toBe(false);
    // Right shape, wrong marker.
    expect(looksLikeApiKey(`xxx_${'a'.repeat(43)}`)).toBe(false);
  });

  it('does not throw on hostile input', () => {
    for (const bad of ['\0', '../../etc/passwd', '💥', 'ggk_' + '\n'.repeat(43)]) {
      expect(() => looksLikeApiKey(bad)).not.toThrow();
    }
  });
});

describe('hashesMatch', () => {
  it('matches identical hashes and rejects different ones', () => {
    const a = hashApiKey('ggk_one');
    expect(hashesMatch(a, hashApiKey('ggk_one'))).toBe(true);
    expect(hashesMatch(a, hashApiKey('ggk_two'))).toBe(false);
  });

  it('rejects length mismatches without throwing', () => {
    expect(hashesMatch('abc', 'abcd')).toBe(false);
  });
});

describe('isReadOnlySafeMethod', () => {
  it('allows only safe methods, case-insensitively', () => {
    for (const m of ['GET', 'get', 'HEAD', 'options']) {
      expect(isReadOnlySafeMethod(m)).toBe(true);
    }
    for (const m of ['POST', 'PATCH', 'PUT', 'DELETE', 'post']) {
      expect(isReadOnlySafeMethod(m)).toBe(false);
    }
  });
});
