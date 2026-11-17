// SPDX-License-Identifier: AGPL-3.0-or-later
import { Prisma } from '@prisma/client';

/**
 * A geographic boundary was configured and cannot be resolved.
 * Readers must see no rows. This is not a geometry.
 */
export const CLOSED_GEO_LIMIT = { closed: true } as const;

export function isClosedGeoLimit(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { closed?: unknown }).closed === true &&
    !('type' in (value as object))
  );
}

/**
 * SQL that keeps a row inside a clip, or matches nothing when the
 * clip is closed. `prefix` is `AND ` for WHERE tails and empty when
 * the fragment is joined with AND already.
 */
export function geoLimitSql(
  limit: unknown,
  column: 'geom' | 'p.geom',
  prefix: '' | 'AND ',
): Prisma.Sql {
  if (isClosedGeoLimit(limit)) {
    return prefix === 'AND ' ? Prisma.sql`AND false` : Prisma.sql`false`;
  }
  const json = JSON.stringify(limit);
  if (column === 'p.geom') {
    return prefix === 'AND '
      ? Prisma.sql`AND (p.geom IS NULL OR ST_Intersects(p.geom, ST_SetSRID(ST_GeomFromGeoJSON(${json}::text), 4326)))`
      : Prisma.sql`(p.geom IS NULL OR ST_Intersects(p.geom, ST_SetSRID(ST_GeomFromGeoJSON(${json}::text), 4326)))`;
  }
  return prefix === 'AND '
    ? Prisma.sql`AND (geom IS NULL OR ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON(${json}::text), 4326)))`
    : Prisma.sql`(geom IS NULL OR ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON(${json}::text), 4326)))`;
}

/** Intersects-only form used by extent queries. A closed clip matches nothing. */
export function geoLimitIntersectsSql(limit: unknown): Prisma.Sql {
  if (isClosedGeoLimit(limit)) return Prisma.sql`AND false`;
  const json = JSON.stringify(limit);
  return Prisma.sql`AND ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON(${json}::text), 4326))`;
}
