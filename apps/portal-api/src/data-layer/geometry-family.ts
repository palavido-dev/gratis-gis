// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

/**
 * Which declared layer geometry type a GeoJSON geometry type belongs
 * to. Multi* parts count as the same family as their single form,
 * the way imports, OSM saves and drawing promotion already treat
 * them: a polygon layer routinely holds MultiPolygons.
 */
const FAMILY: Record<string, 'point' | 'line' | 'polygon'> = {
  Point: 'point',
  MultiPoint: 'point',
  LineString: 'line',
  MultiLineString: 'line',
  Polygon: 'polygon',
  MultiPolygon: 'polygon',
};

const PLURAL = { point: 'points', line: 'lines', polygon: 'polygons' } as const;

/**
 * The family mismatch of one geometry against a declared layer type,
 * or null when it fits. A GeometryCollection fits when every member
 * does. Shapes this check does not recognise are left to the other
 * validation on the write path, so only a clear mismatch is refused.
 */
function mismatch(
  declared: 'point' | 'line' | 'polygon',
  geom: unknown,
): string | null {
  if (!geom || typeof geom !== 'object') return null;
  const g = geom as { type?: unknown; geometries?: unknown };
  if (g.type === 'GeometryCollection') {
    if (!Array.isArray(g.geometries)) return null;
    for (const member of g.geometries) {
      const m = mismatch(declared, member);
      if (m) return m;
    }
    return null;
  }
  if (typeof g.type !== 'string') return null;
  const family = FAMILY[g.type];
  if (!family || family === declared) return null;
  return g.type;
}

/**
 * Refuse a write whose geometry does not match the layer's declared
 * geometry type, for example a Point posted to a polygon layer.
 *
 * Only a layer declared exactly as 'point', 'line' or 'polygon' is
 * checked. A table (null), a layer with no declared type, or any
 * other stored value keeps accepting every geometry, as before.
 * Missing and null geometries pass: attribute-only writes are normal.
 */
export function assertGeometryFamilies(
  declaredType: unknown,
  geoms: ReadonlyArray<unknown>,
): void {
  if (declaredType !== 'point' && declaredType !== 'line' && declaredType !== 'polygon') {
    return;
  }
  const offending: number[] = [];
  let firstType = '';
  geoms.forEach((geom, i) => {
    const m = mismatch(declaredType, geom);
    if (m) {
      if (offending.length === 0) firstType = m;
      offending.push(i);
    }
  });
  if (offending.length === 0) return;
  const holds = PLURAL[declaredType];
  throw new BadRequestException({
    message:
      offending.length === 1 && geoms.length === 1
        ? `This layer holds ${holds}, so a ${firstType} cannot be saved to it.`
        : `This layer holds ${holds}. ${offending.length} of the features have a different geometry type (the first is a ${firstType}) and cannot be saved to it.`,
    code: 'geometry_type_mismatch',
    offendingIndices: offending,
  });
}
