// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  looksLikeJwt,
  looksLikePortalApiKey,
} from './auth-token.js';

describe('looksLikePortalApiKey', () => {
  it('accepts ggk_ + 43 base64url chars', () => {
    assert.equal(
      looksLikePortalApiKey(`ggk_${'A'.repeat(43)}`),
      true,
    );
  });

  it('rejects short or wrong-prefix values', () => {
    assert.equal(looksLikePortalApiKey('ggk_short'), false);
    assert.equal(looksLikePortalApiKey(`xxx_${'A'.repeat(43)}`), false);
    assert.equal(looksLikePortalApiKey(''), false);
  });
});

describe('looksLikeJwt', () => {
  it('accepts three-segment base64url blobs', () => {
    assert.equal(looksLikeJwt('aaa.bbb.ccc'), true);
    assert.equal(
      looksLikeJwt(
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturehere',
      ),
      true,
    );
  });

  it('rejects API keys and plain strings', () => {
    assert.equal(looksLikeJwt(`ggk_${'A'.repeat(43)}`), false);
    assert.equal(looksLikeJwt('not-a-jwt'), false);
    assert.equal(looksLikeJwt('a.b'), false);
  });
});
