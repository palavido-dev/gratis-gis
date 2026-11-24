// SPDX-License-Identifier: AGPL-3.0-or-later
import { landingOrgSlug, publicOrgSlug, withListOrgId, withOrgQuery } from './public-org';

describe('publicOrgSlug', () => {
  it('reads the org slug from search params or a query object', () => {
    expect(publicOrgSlug(new URLSearchParams('org=acme'))).toBe('acme');
    expect(publicOrgSlug({ org: ' acme ' })).toBe('acme');
  });

  it('ignores a missing, empty, repeated or oversized value', () => {
    expect(publicOrgSlug(undefined)).toBeUndefined();
    expect(publicOrgSlug(new URLSearchParams(''))).toBeUndefined();
    expect(publicOrgSlug({ org: '' })).toBeUndefined();
    expect(publicOrgSlug({ org: ['a', 'b'] })).toBeUndefined();
    expect(publicOrgSlug({ org: 'x'.repeat(101) })).toBeUndefined();
  });
});

describe('withOrgQuery', () => {
  it('leaves the path alone without a slug', () => {
    expect(withOrgQuery('/api/public/landing', undefined)).toBe('/api/public/landing');
  });

  it('adds the slug, encoded, with the right separator', () => {
    expect(withOrgQuery('/api/public/landing', 'acme')).toBe('/api/public/landing?org=acme');
    expect(withOrgQuery('/x?a=1', 'a b&c')).toBe('/x?a=1&org=a%20b%26c');
  });
});

describe('landingOrgSlug', () => {
  it('passes the slug on only when the install serves many orgs', () => {
    expect(landingOrgSlug({ org: 'acme' }, true)).toBe('acme');
    expect(landingOrgSlug({ org: 'acme' }, false)).toBeUndefined();
    expect(landingOrgSlug(undefined, true)).toBeUndefined();
  });
});

describe('withListOrgId', () => {
  it("names the item's org on a signed-out list only when the install serves many orgs", () => {
    const path = '/api/items?type=basemap&full=1';
    expect(withListOrgId(path, 'o 1', true)).toBe('/api/items?type=basemap&full=1&orgId=o%201');
    expect(withListOrgId('/api/items', 'o1', true)).toBe('/api/items?orgId=o1');
    expect(withListOrgId(path, 'o1', false)).toBe(path);
    expect(withListOrgId(path, undefined, true)).toBe(path);
  });
});
