// SPDX-License-Identifier: AGPL-3.0-or-later
import { presentedEsriToken, signEsriToken, verifyEsriToken } from './esri-token.js';

const KEY = Buffer.alloc(32, 7);
const OTHER = Buffer.alloc(32, 8);

describe('Esri tokens', () => {
  it('round-trips and expires', () => {
    const t = signEsriToken({ kid: 'k1', exp: 2_000 }, KEY);
    expect(verifyEsriToken(t, KEY, 1_000)).toEqual({ kid: 'k1', exp: 2_000 });
    expect(verifyEsriToken(t, KEY, 3_000)).toBeNull();
  });

  it('refuses another key, a changed body and junk', () => {
    const t = signEsriToken({ kid: 'k1', exp: 2_000 }, KEY);
    expect(verifyEsriToken(t, OTHER, 1_000)).toBeNull();
    const [prefix, body, mac] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ kid: 'k2', exp: 2_000 })).toString('base64url');
    expect(verifyEsriToken(`${prefix}.${forged}.${mac}`, KEY, 1_000)).toBeNull();
    expect(verifyEsriToken(`${prefix}.${body}`, KEY, 1_000)).toBeNull();
    expect(verifyEsriToken('ggk_abc', KEY, 1_000)).toBeNull();
  });

  it('finds the token in the header, the query or the form body', () => {
    expect(presentedEsriToken({ headers: { 'x-esri-authorization': 'Bearer abc' } })).toBe('abc');
    expect(presentedEsriToken({ query: { token: 'q' }, body: { token: 'b' } })).toBe('q');
    expect(presentedEsriToken({ query: {}, body: { token: 'b' } })).toBe('b');
    expect(presentedEsriToken({ query: {}, body: undefined, headers: {} })).toBeUndefined();
  });
});
