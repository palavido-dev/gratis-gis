// SPDX-License-Identifier: AGPL-3.0-or-later
import { byteProxyCacheControl } from './byte-proxy-cache.js';

describe('byteProxyCacheControl', () => {
  it('is private for a signed-in caller, whose item may be shared, not public', () => {
    expect(byteProxyCacheControl({ id: 'u' }, 3600)).toBe('private, max-age=3600');
    expect(byteProxyCacheControl({ id: 'u' }, 86400, { immutable: true })).toBe(
      'private, max-age=86400, immutable',
    );
  });

  it('stays public for anonymous callers, who only resolve public items', () => {
    expect(byteProxyCacheControl(null, 3600)).toBe('public, max-age=3600');
  });
});
