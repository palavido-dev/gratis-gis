// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Whether a new feature was placed at the device's GPS fix, which is
 * the only case where stamping the fix into its GPS columns is true.
 *
 * The stamp used to run on every add with a fix: a point tapped on
 * the map 200 m away, a drawn polygon, a related table row. Each got
 * the phone's coordinates and accuracy, which disagreed with its own
 * geometry. Now only a point at (or within the fix's own accuracy of)
 * the GPS position counts.
 */
export function placedAtGpsFix(
  geometry: GeoJSON.Geometry | null | undefined,
  fix: { lon: number; lat: number; accuracyM: number | null } | null,
): boolean {
  if (!fix || !geometry || geometry.type !== 'Point') return false;
  const [lon, lat] = geometry.coordinates;
  if (typeof lon !== 'number' || typeof lat !== 'number') return false;
  // Equirectangular distance is plenty at these scales.
  const R = 6_371_000;
  const toRad = Math.PI / 180;
  const dx = (lon - fix.lon) * toRad * Math.cos(((lat + fix.lat) / 2) * toRad);
  const dy = (lat - fix.lat) * toRad;
  const meters = Math.sqrt(dx * dx + dy * dy) * R;
  // The fix moves a little between placing the point and saving it.
  const tolerance = Math.max(2 * (fix.accuracyM ?? 0), 10);
  return meters <= tolerance;
}
