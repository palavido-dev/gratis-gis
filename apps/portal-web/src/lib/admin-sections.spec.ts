// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  ADMIN_GROUPS,
  ADMIN_SECTIONS,
  searchSections,
  sectionForPath,
  visibleSections,
} from './admin-sections';

describe('admin sections', () => {
  it('lists every admin page once, in a known group', () => {
    const adminDir = join(__dirname, '..', 'app', 'admin');
    const pages = readdirSync(adminDir)
      .filter((d) => statSync(join(adminDir, d)).isDirectory())
      .filter((d) => d !== 'getting-started')
      .map((d) => `/admin/${d}`)
      .sort();
    expect(ADMIN_SECTIONS.map((s) => s.href).sort()).toEqual(pages);
    for (const s of ADMIN_SECTIONS) expect(ADMIN_GROUPS).toContain(s.group);
  });

  it('hides operator-only pages from other admins', () => {
    const others = visibleSections(false).map((s) => s.id);
    expect(others).not.toContain('backup');
    expect(others).not.toContain('signIn');
    expect(others).toContain('email');
    expect(visibleSections(true)).toHaveLength(ADMIN_SECTIONS.length);
  });

  it('finds a page by its keywords as well as its words', () => {
    const text = (s: { id: string }) => s.id;
    expect(searchSections(ADMIN_SECTIONS, 'smtp', text).map((s) => s.id)).toEqual(['email']);
    expect(searchSections(ADMIN_SECTIONS, 'ArcGIS export', text).map((s) => s.id)).toEqual([
      'agoImport',
    ]);
    expect(searchSections(ADMIN_SECTIONS, '  ', text)).toHaveLength(ADMIN_SECTIONS.length);
  });

  it('maps a nested admin path to its section', () => {
    expect(sectionForPath('/admin/users')?.id).toBe('users');
    expect(sectionForPath('/admin/migrations/ago/123')?.id).toBe('agoImport');
    expect(sectionForPath('/admin')).toBeNull();
  });
});
