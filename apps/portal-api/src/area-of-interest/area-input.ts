// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

/**
 * Checks for the shape a What's Here area starts from (#796): a drawn
 * shape, a tapped point, a geocoded address, the union of picked
 * features or an uploaded file, plus an optional distance.
 *
 * PostGIS would reject most of this itself, but as a 500 from inside
 * a query. Checking here turns a careless or hostile body into a 400
 * that says what is wrong, and means a database error on this route
 * is a real fault rather than bad input.
 */

/** Ids are the first 128 bits of a SHA-256, as lowercase hex. */
export const AREA_ID_RE = /^[0-9a-f]{32}$/;

/**
 * Largest distance a caller may buffer by. 100 km covers "everything
 * within 50 miles" with room to spare. Past that the buffer of a
 * detailed shape gets expensive and the question stops being a site
 * screen.
 */
export const MAX_DISTANCE_METERS = 100_000;

const GEOMETRY_TYPES = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
]);

/** Collections nest; real input never goes deeper than this. */
const MAX_COLLECTION_DEPTH = 4;

export interface AreaInput {
  geometry: Record<string, unknown>;
  distanceMeters: number;
}

function bad(msg: string): never {
  throw new BadRequestException(msg);
}

function checkPosition(p: unknown): void {
  if (!Array.isArray(p) || p.length < 2 || p.length > 4) {
    bad('Each position must be [longitude, latitude].');
  }
  for (const n of p) {
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      bad('Coordinates must be finite numbers.');
    }
  }
  const [lon, lat] = p as [number, number];
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
    bad('Coordinates must be longitude and latitude in degrees (WGS84).');
  }
}

function checkLine(line: unknown, min: number, what: string): void {
  if (!Array.isArray(line) || line.length < min) {
    bad(`A ${what} needs at least ${min} positions.`);
  }
  for (const p of line) checkPosition(p);
}

function checkPolygon(rings: unknown): void {
  if (!Array.isArray(rings) || rings.length === 0) {
    bad('A polygon needs at least one ring.');
  }
  for (const ring of rings) checkLine(ring, 4, 'polygon ring');
}

function checkGeometry(g: unknown, depth: number): void {
  if (!g || typeof g !== 'object' || Array.isArray(g)) {
    bad('geometry must be a GeoJSON geometry object.');
  }
  const obj = g as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== 'string' || !GEOMETRY_TYPES.has(type)) {
    bad(
      'geometry.type must be one of ' + [...GEOMETRY_TYPES].join(', ') + '.',
    );
  }
  if (type === 'GeometryCollection') {
    if (depth >= MAX_COLLECTION_DEPTH) bad('Geometry collections nest too deep.');
    if (!Array.isArray(obj.geometries) || obj.geometries.length === 0) {
      bad('A geometry collection needs at least one geometry.');
    }
    for (const child of obj.geometries) checkGeometry(child, depth + 1);
    return;
  }
  const c = obj.coordinates;
  switch (type) {
    case 'Point':
      checkPosition(c);
      return;
    case 'MultiPoint':
      checkLine(c, 1, 'multipoint');
      return;
    case 'LineString':
      checkLine(c, 2, 'line');
      return;
    case 'MultiLineString':
      if (!Array.isArray(c) || c.length === 0) bad('A multiline needs a line.');
      for (const line of c) checkLine(line, 2, 'line');
      return;
    case 'Polygon':
      checkPolygon(c);
      return;
    case 'MultiPolygon':
      if (!Array.isArray(c) || c.length === 0) bad('A multipolygon needs a polygon.');
      for (const poly of c) checkPolygon(poly);
      return;
  }
}

export function parseAreaInput(body: unknown): AreaInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    bad('Send { geometry, distanceMeters? }.');
  }
  const { geometry, distanceMeters } = body as Record<string, unknown>;
  checkGeometry(geometry, 0);
  let distance = 0;
  if (distanceMeters !== undefined && distanceMeters !== null) {
    if (typeof distanceMeters !== 'number' || !Number.isFinite(distanceMeters)) {
      bad('distanceMeters must be a number.');
    }
    if (distanceMeters < 0 || distanceMeters > MAX_DISTANCE_METERS) {
      bad(`distanceMeters must be between 0 and ${MAX_DISTANCE_METERS}.`);
    }
    distance = distanceMeters;
  }
  return {
    geometry: geometry as Record<string, unknown>,
    distanceMeters: distance,
  };
}

/** The `area` parameter on the aggregate reads: an id from register. */
export function parseAreaId(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || !AREA_ID_RE.test(raw)) {
    bad('area must be an id returned by POST /api/areas-of-interest.');
  }
  return raw;
}
