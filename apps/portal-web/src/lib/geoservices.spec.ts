// SPDX-License-Identifier: AGPL-3.0-or-later
import { featureServerUrl, geoservicesServiceName } from './geoservices';

const ID = '0193f2a4-0000-7000-8000-000000000001';

describe('geoservices URLs', () => {
  it('builds the same service name as the API', () => {
    // Pinned to the API's own spec case (featureserver-access.spec.ts).
    expect(geoservicesServiceName(ID, 'Parcels: Randolph County (2026)')).toBe(
      `Parcels_Randolph_County_2026_${ID}`,
    );
    expect(geoservicesServiceName(ID, '***')).toBe(ID);
    expect(geoservicesServiceName(ID, 'Café Sites')).toBe(`Cafe_Sites_${ID}`);
  });

  it('builds the FeatureServer URL', () => {
    expect(featureServerUrl('https://demo.example.org/', ID, 'Sites')).toBe(
      `https://demo.example.org/api/geoservices/rest/services/Sites_${ID}/FeatureServer`,
    );
  });
});
