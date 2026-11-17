// SPDX-License-Identifier: AGPL-3.0-or-later
jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(async (host: string) =>
    host === 'internal.example'
      ? [{ address: '10.0.0.5', family: 4 }]
      : [{ address: '93.184.216.34', family: 4 }],
  ),
}));

import { BadRequestException } from '@nestjs/common';

import { assertAlias, assertPublicHttps } from './oidc-url';

describe('assertPublicHttps', () => {
  it('accepts a public https URL', async () => {
    await expect(
      assertPublicHttps('https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize'),
    ).resolves.toContain('login.microsoftonline.com');
  });

  it('refuses http and link-local hosts', async () => {
    await expect(assertPublicHttps('http://login.example.com/authorize')).rejects.toThrow(
      BadRequestException,
    );
    await expect(assertPublicHttps('https://169.254.169.254/latest')).rejects.toThrow(
      BadRequestException,
    );
    await expect(assertPublicHttps('https://localhost/auth')).rejects.toThrow(BadRequestException);
  });

  it.each([
    'https://localhost./auth',
    'https://[::ffff:127.0.0.1]/auth',
    'https://[::ffff:169.254.169.254]/token',
    'https://169.254.1.1/token',
    'https://[fd00::1]/token',
    'https://100.64.0.1/token',
    'https://keycloak:8443/token',
    'https://internal.example/token',
  ])('refuses %s', async (url) => {
    await expect(assertPublicHttps(url)).rejects.toThrow(BadRequestException);
  });
});

describe('assertAlias', () => {
  it('lowercases a valid alias', () => {
    expect(assertAlias('Entra')).toBe('entra');
  });
});
