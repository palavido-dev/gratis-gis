// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import { assertAlias, assertPublicHttps } from './oidc-url';

describe('assertPublicHttps', () => {
  it('accepts a public https URL', () => {
    expect(assertPublicHttps('https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize')).toContain(
      'login.microsoftonline.com',
    );
  });

  it('refuses http and link-local hosts', () => {
    expect(() => assertPublicHttps('http://login.example.com/authorize')).toThrow(
      BadRequestException,
    );
    expect(() => assertPublicHttps('https://169.254.169.254/latest')).toThrow(
      BadRequestException,
    );
    expect(() => assertPublicHttps('https://localhost/auth')).toThrow(BadRequestException);
  });
});

describe('assertAlias', () => {
  it('lowercases a valid alias', () => {
    expect(assertAlias('Entra')).toBe('entra');
  });
});
