// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pick the KML document inside a KMZ (a zip). GDAL's KML driver reads
 * `.kml`. The LIBKML driver that opens a `.kmz` directly is often not
 * built into the system GDAL, so ingest opens `/vsizip/<file>/<member>`
 * instead of handing GDAL the archive path.
 */

/** Relative `.kml` member to open, or null when the archive has none. */
export function preferredKmlZipEntry(names: readonly string[]): string | null {
  const kml: string[] = [];
  for (const name of names) {
    if (name.startsWith('/') || name.startsWith('\\')) continue;
    const norm = name.replace(/\\/g, '/');
    if (!norm || norm.endsWith('/')) continue;
    const segments = norm.split('/');
    if (segments.some((segment) => segment === '..' || segment === '')) continue;
    if (!norm.toLowerCase().endsWith('.kml')) continue;
    kml.push(norm);
  }
  const doc = kml.find((name) => name.split('/').pop()?.toLowerCase() === 'doc.kml');
  return doc ?? kml[0] ?? null;
}
