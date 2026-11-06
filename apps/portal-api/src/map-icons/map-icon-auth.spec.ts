// SPDX-License-Identifier: AGPL-3.0-or-later
import { canDeleteMapIcon } from './map-icon-auth.js';

describe('canDeleteMapIcon', () => {
  const row = { createdBy: 'user-a' };

  it('allows the uploader and an org admin', () => {
    expect(canDeleteMapIcon({ id: 'user-a', orgRole: 'viewer' }, row)).toBe(true);
    expect(canDeleteMapIcon({ id: 'user-b', orgRole: 'admin' }, row)).toBe(true);
  });

  it('refuses a different member who is not an admin', () => {
    expect(canDeleteMapIcon({ id: 'user-b', orgRole: 'contributor' }, row)).toBe(false);
    expect(canDeleteMapIcon({ id: 'user-b', orgRole: 'viewer' }, row)).toBe(false);
  });
});
