// SPDX-License-Identifier: AGPL-3.0-or-later
import { clientUuid } from './uuid';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('clientUuid', () => {
  it('returns an RFC 4122 id when randomUUID exists', () => {
    expect(clientUuid()).toMatch(UUID);
  });

  it('still returns an id on an insecure origin where randomUUID is missing', () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, 'randomUUID', {
      configurable: true,
      value: undefined,
    });
    try {
      expect(typeof crypto.randomUUID).not.toBe('function');
      expect(clientUuid()).toMatch(UUID);
    } finally {
      Object.defineProperty(crypto, 'randomUUID', {
        configurable: true,
        value: original,
      });
    }
  });
});
