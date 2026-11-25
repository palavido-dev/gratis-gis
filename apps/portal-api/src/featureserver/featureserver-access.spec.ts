// SPDX-License-Identifier: AGPL-3.0-or-later
import { itemIdFromServiceName, serviceName } from './featureserver-access.service.js';

const ID = '0193f2a4-0000-7000-8000-000000000001';

describe('service names', () => {
  it('puts a readable title ahead of the item id', () => {
    expect(serviceName(ID, 'Parcels: Randolph County (2026)')).toBe(`Parcels_Randolph_County_2026_${ID}`);
    expect(serviceName(ID, '***')).toBe(ID);
  });

  it('finds the item id in either form, and only at the end', () => {
    expect(itemIdFromServiceName(`Parcels_${ID}`)).toBe(ID);
    expect(itemIdFromServiceName(ID.toUpperCase())).toBe(ID);
    expect(itemIdFromServiceName(`Parcels${ID}`)).toBeNull();
    expect(itemIdFromServiceName(`${ID}_x`)).toBeNull();
    expect(itemIdFromServiceName('Parcels')).toBeNull();
  });
});
