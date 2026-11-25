// SPDX-License-Identifier: AGPL-3.0-or-later
import type { KeycloakUserRep } from './keycloak-admin.service.js';
import { keycloakAccountInOrg, keycloakOrgAttribute } from './keycloak-org.js';

describe('Keycloak account organization', () => {
  const org = { orgId: 'org-1', orgSlug: 'acme' };
  const account = (org?: string[]): KeycloakUserRep =>
    ({
      id: 'kc-1',
      username: 'ana',
      enabled: true,
      ...(org === undefined ? {} : { attributes: { org } }),
    }) as KeycloakUserRep;

  it('matches the organization slug', () => {
    expect(keycloakAccountInOrg(account(['acme']), org)).toBe(true);
  });

  it('matches the organization id', () => {
    expect(keycloakAccountInOrg(account(['org-1']), org)).toBe(true);
  });

  it('does not match another organization, or no attribute', () => {
    expect(keycloakAccountInOrg(account(['other-org']), org)).toBe(false);
    expect(keycloakAccountInOrg(account(), org)).toBe(false);
    expect(keycloakAccountInOrg(account([]), org)).toBe(false);
    expect(keycloakAccountInOrg(account(['']), org)).toBe(false);
  });

  it('reads only the first value', () => {
    expect(keycloakOrgAttribute(account(['other-org', 'acme']))).toBe('other-org');
    expect(keycloakAccountInOrg(account(['other-org', 'acme']), org)).toBe(false);
    expect(keycloakAccountInOrg(account(['acme', 'other-org']), org)).toBe(true);
  });
});
