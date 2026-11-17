// SPDX-License-Identifier: AGPL-3.0-or-later
import { isUnsafeApiUrl, isUuid } from './api-path-guard';

describe('isUnsafeApiUrl', () => {
  it('passes ordinary API URLs', () => {
    expect(isUnsafeApiUrl('/api/portal/items/0b1c2d3e-0000-4000-8000-000000000001/geojson')).toBe(false);
    expect(isUnsafeApiUrl('/api/portal/items/x/layers/a%20b/features?entity=1&q=../x')).toBe(false);
    expect(isUnsafeApiUrl('/api/portal/items/')).toBe(false);
    expect(isUnsafeApiUrl('https://tiles.example.com/../x')).toBe(false);
    expect(isUnsafeApiUrl('/other/../x')).toBe(false);
  });

  it('refuses a saved id that walks to another endpoint', () => {
    expect(isUnsafeApiUrl('/api/portal/postgis-live/../scripts/S/run?x=/features')).toBe(true);
    expect(isUnsafeApiUrl('/api/portal/items/%2e%2e/admin/x')).toBe(true);
    expect(isUnsafeApiUrl('/api/portal/items/a\\..\\b/geojson')).toBe(true);
    expect(isUnsafeApiUrl('/api/portal/items//geojson')).toBe(true);
    expect(isUnsafeApiUrl('/api/portal/items/./geojson')).toBe(true);
  });

  it('checks absolute URLs on this origin only', () => {
    expect(isUnsafeApiUrl('https://portal.example/api/portal/x/../y', 'https://portal.example')).toBe(true);
    expect(isUnsafeApiUrl('https://other.example/api/portal/x/../y', 'https://portal.example')).toBe(false);
  });
});

describe('isUuid', () => {
  it('accepts canonical UUIDs only', () => {
    expect(isUuid('0b1c2d3e-0000-4000-8000-000000000001')).toBe(true);
    expect(isUuid('../scripts/x/run?x=')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});
