// SPDX-License-Identifier: AGPL-3.0-or-later
// Negative fixture. Prisma binds the GeoJSON. The CI rule must not flag it.
declare const Prisma: { sql: (s: TemplateStringsArray, ...v: unknown[]) => unknown };

export async function bound(prisma: { $queryRaw: Function }, json: string) {
  const rows = await prisma.$queryRaw`SELECT ST_GeomFromGeoJSON(${json}::text)`;
  return rows;
}

export function fragment(json: string) {
  return Prisma.sql`AND ST_GeomFromGeoJSON(${json}::text)`;
}

export function placeholder(geojson: string) {
  return ['SELECT ST_GeomFromGeoJSON($1)', geojson];
}
