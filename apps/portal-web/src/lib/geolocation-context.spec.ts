// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  geolocationBlock,
  isInsecureGeolocationMessage,
} from './geolocation-context';

describe('geolocationBlock', () => {
  it('blocks plain HTTP even when the browser has a geolocation API', () => {
    expect(geolocationBlock(false, true)).toBe('insecure-context');
  });

  it('allows a secure context that implements geolocation', () => {
    expect(geolocationBlock(true, true)).toBeNull();
  });

  it('reports a missing API only after the context is secure', () => {
    expect(geolocationBlock(true, false)).toBe('unsupported');
  });
});

describe('isInsecureGeolocationMessage', () => {
  it('recognizes the Chromium secure-origin error', () => {
    expect(
      isInsecureGeolocationMessage(
        'Only secure origins are allowed (see: https://goo.gl/Y0ZkNV).',
      ),
    ).toBe(true);
  });

  it('does not treat a timeout as an insecure origin', () => {
    expect(isInsecureGeolocationMessage('Timeout expired')).toBe(false);
  });
});
