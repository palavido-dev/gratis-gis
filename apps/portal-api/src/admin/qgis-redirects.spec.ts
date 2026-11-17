// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  QGIS_CUSTOM_SCHEME_REDIRECT,
  QGIS_LOOPBACK_REDIRECT,
  qgisRedirectUris,
  qgisRedirectsChanged,
} from './qgis-redirects.js';

describe('qgisRedirectUris', () => {
  it('replaces the open loopback wildcard and keeps the custom scheme', () => {
    const next = qgisRedirectUris([
      'gratisgis-qgis://auth-callback',
      'http://127.0.0.1*',
    ]);
    expect(next).toContain(QGIS_CUSTOM_SCHEME_REDIRECT);
    expect(next).toContain(QGIS_LOOPBACK_REDIRECT);
    expect(next).not.toContain('http://127.0.0.1*');
  });

  it('does not treat a port wildcard as the open host wildcard', () => {
    const next = qgisRedirectUris([QGIS_LOOPBACK_REDIRECT]);
    expect(next.filter((uri) => uri === QGIS_LOOPBACK_REDIRECT)).toHaveLength(1);
  });

  it('keeps an extra redirect an operator added', () => {
    const next = qgisRedirectUris([
      'gratisgis-qgis://auth-callback',
      'http://127.0.0.1:43821/callback',
    ]);
    expect(next).toContain('http://127.0.0.1:43821/callback');
  });

  it('reports no change when the list is already safe', () => {
    const current = [QGIS_CUSTOM_SCHEME_REDIRECT, QGIS_LOOPBACK_REDIRECT];
    expect(qgisRedirectsChanged(current)).toBe(false);
    expect(qgisRedirectsChanged(['http://127.0.0.1*'])).toBe(true);
  });
});
