// SPDX-License-Identifier: AGPL-3.0-or-later
import { getPortalUrl } from './portal-url';

describe('getPortalUrl (54-10)', () => {
  const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

  it('prefers the build-time public URL', () => {
    expect(
      getPortalUrl(env({ NEXT_PUBLIC_PORTAL_URL: 'https://gis.example.com/', NEXTAUTH_URL: 'https://x.test' })),
    ).toBe('https://gis.example.com');
  });

  it('falls back to the runtime public URL on a prebuilt image', () => {
    expect(getPortalUrl(env({ NEXTAUTH_URL: 'http://192.168.1.20:8085' }))).toBe(
      'http://192.168.1.20:8085',
    );
    expect(getPortalUrl(env({ PUBLIC_URL: 'https://gis.example.org/' }))).toBe(
      'https://gis.example.org',
    );
  });

  it('keeps the demo default when nothing is configured', () => {
    expect(getPortalUrl(env({}))).toBe('https://demo.gratisgis.org');
    expect(getPortalUrl(env({ NEXTAUTH_URL: 'not a url' }))).toBe('https://demo.gratisgis.org');
  });
});
