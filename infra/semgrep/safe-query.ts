// SPDX-License-Identifier: AGPL-3.0-or-later
// Negative fixture. The GeoJSON is a bound parameter, not interpolated SQL.
export async function safeGeoJson(db: { query: (sql: string, params: unknown[]) => Promise<unknown> }, geojson: string) {
  const sql = 'SELECT ST_GeomFromGeoJSON($1)';
  return db.query(sql, [geojson]);
}
