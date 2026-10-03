// SPDX-License-Identifier: AGPL-3.0-or-later
import { featuresFromAddresses, planAddressGeocode } from './csv-address.js';

describe('planAddressGeocode', () => {
  it('names a single address column', () => {
    const plan = planAddressGeocode(
      'name,address\nOffice,"1600 Pennsylvania Ave NW, Washington, DC"\n',
    );
    expect(plan.kind).toBe('address');
    if (plan.kind !== 'address') return;
    expect(plan.label).toBe('address');
    expect(plan.queries).toEqual(['1600 Pennsylvania Ave NW, Washington, DC']);
  });

  it('joins street, city, state, and zip', () => {
    const plan = planAddressGeocode(
      'street,city,state,zip,name\n123 Main,Springfield,IL,62704,Desk\n',
    );
    expect(plan.kind).toBe('address');
    if (plan.kind !== 'address') return;
    expect(plan.label).toBe('street, city, state, zip');
    expect(plan.queries).toEqual(['123 Main, Springfield, IL, 62704']);
    expect(plan.rows[0]?.[4]).toBe('Desk');
  });

  it('leaves a coordinate file alone', () => {
    const plan = planAddressGeocode(
      'lat,lng,address\n38.9,-77.0,"1600 Pennsylvania Ave NW"\n',
    );
    expect(plan.kind).toBe('none');
  });

  it('rejects a column of bare numbers', () => {
    const plan = planAddressGeocode('address,name\n100,Desk\n200,Lamp\n');
    expect(plan.kind).toBe('none');
  });

  it('keeps only the first 200 data rows', () => {
    const lines = ['address'];
    for (let i = 0; i < 250; i += 1) lines.push(`${i} Main Street`);
    const plan = planAddressGeocode(lines.join('\n'));
    expect(plan.kind).toBe('address');
    if (plan.kind !== 'address') return;
    expect(plan.rows).toHaveLength(200);
  });
});

describe('featuresFromAddresses', () => {
  it('places matched rows as lon, lat points and skips the rest', () => {
    const plan = planAddressGeocode(
      'name,address\nOffice,"1600 Pennsylvania Ave NW"\nAnnex,"1 Nowhere Road"\n',
    );
    if (plan.kind !== 'address') throw new Error('expected a plan');
    const built = featuresFromAddresses(plan, [
      { lat: 38.9, lon: -77.0 },
      null,
    ]);
    expect(built.placed).toBe(1);
    expect(built.features[0]?.geometry.coordinates).toEqual([-77.0, 38.9]);
    expect(built.features[0]?.properties.name).toBe('Office');
  });
});
