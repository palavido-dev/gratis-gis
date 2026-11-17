// SPDX-License-Identifier: AGPL-3.0-or-later
import { initialOrgName } from './auth-sync.service.js';

describe('initialOrgName', () => {
  it('names the install organization from DEFAULT_ORG_NAME', () => {
    expect(initialOrgName('gratis-gis', { DEFAULT_ORG_NAME: 'Acme GIS' })).toBe('Acme GIS');
    expect(
      initialOrgName('acme', { DEFAULT_ORG_SLUG: 'acme', DEFAULT_ORG_NAME: ' Acme GIS ' }),
    ).toBe('Acme GIS');
  });

  it('keeps the slug for other organizations and when no name is set', () => {
    expect(initialOrgName('other-org', { DEFAULT_ORG_NAME: 'Acme GIS' })).toBe('other-org');
    expect(initialOrgName('gratis-gis', { DEFAULT_ORG_NAME: '' })).toBe('gratis-gis');
    expect(initialOrgName('gratis-gis', {})).toBe('gratis-gis');
  });
});
