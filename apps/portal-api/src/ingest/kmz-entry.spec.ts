// SPDX-License-Identifier: AGPL-3.0-or-later
import { preferredKmlZipEntry } from './kmz-entry.js';

describe('preferredKmlZipEntry', () => {
  it('prefers doc.kml and keeps a nested path', () => {
    expect(preferredKmlZipEntry(['files/icon.png', 'layers/doc.kml', 'other.kml'])).toBe(
      'layers/doc.kml',
    );
  });

  it('uses the first kml when Google Earth did not name it doc.kml', () => {
    expect(preferredKmlZipEntry(['readme.txt', 'sectors.kml'])).toBe('sectors.kml');
  });

  it('rejects path traversal and absolute names', () => {
    expect(preferredKmlZipEntry(['../secret.kml', '/tmp/x.kml'])).toBeNull();
  });

  it('returns null when the archive has no kml', () => {
    expect(preferredKmlZipEntry(['doc.kml.png', 'tiles/'])).toBeNull();
  });
});
