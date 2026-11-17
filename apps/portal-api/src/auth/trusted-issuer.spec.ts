// SPDX-License-Identifier: AGPL-3.0-or-later
import { allowedKeycloakIssuers } from './trusted-issuer.js';

describe('allowedKeycloakIssuers', () => {
  it('uses KEYCLOAK_URL when no extra origins are configured', () => {
    expect(
      allowedKeycloakIssuers({
        KEYCLOAK_URL: 'http://192.168.15.82:8085/auth',
        KEYCLOAK_REALM: 'gratis-gis',
      } as NodeJS.ProcessEnv),
    ).toEqual(['http://192.168.15.82:8085/auth/realms/gratis-gis']);
  });

  it('builds a LAN-style issuer for each allowed portal origin', () => {
    expect(
      allowedKeycloakIssuers({
        KEYCLOAK_URL: 'http://192.168.15.82:8085/auth',
        KEYCLOAK_REALM: 'gratis-gis',
        AUTH_ALLOWED_ORIGINS:
          'http://192.168.15.82:8085, https://mynas.tail1234.ts.net',
      } as NodeJS.ProcessEnv),
    ).toEqual([
      'http://192.168.15.82:8085/auth/realms/gratis-gis',
      'https://mynas.tail1234.ts.net/auth/realms/gratis-gis',
    ]);
  });

  it('does not prefix a public Keycloak hostname', () => {
    expect(
      allowedKeycloakIssuers({
        KEYCLOAK_URL: 'https://auth.example.org',
        KEYCLOAK_REALM: 'gratis-gis',
      } as NodeJS.ProcessEnv),
    ).toEqual(['https://auth.example.org/realms/gratis-gis']);
  });
});
