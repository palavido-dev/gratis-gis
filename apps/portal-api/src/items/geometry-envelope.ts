// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Axis aligned envelope, [west, south, east, north], in whatever CRS
 * the input positions were in (EPSG:4326 for everything the engine
 * stores). Same shape as `item.bbox`, on purpose: the whole point of
 * these helpers is to update that column arithmetically instead of
 * re-aggregating the observation table.
 *
 * Pure functions, no Nest, no Prisma, so they can be unit tested
 * without a database and reused from any write path.
 */
export type Envelope = [number, number, number, number];

/**
 * Envelope of one GeoJSON geometry. Handles all seven geometry types
 * (Point, MultiPoint, LineString, MultiLineString, Polygon,
 * MultiPolygon, GeometryCollection). Returns null for a null or
 * unrecognised geometry and for a geometry with no finite position,
 * so "no geometry" and "geometry that cannot bound anything" both
 * mean "does not touch the extent".
 *
 * Positions are read as [x, y] and any third or fourth ordinate is
 * ignored; a position whose x or y is not a finite number is skipped
 * rather than poisoning the whole envelope with NaN.
 *
 * The antimeridian is deliberately NOT special cased. A geometry that
 * crosses 180 degrees yields an envelope spanning most of the world,
 * exactly as ST_Extent does in `DataLayerTablesService.aggregateBbox`.
 * The two computations must agree or the incremental path here would
 * produce a different bbox from the full recompute for the same rows,
 * and the area filter would flip depending on which path ran last.
 */
export function geometryEnvelope(geometry: unknown): Envelope | null {
  if (!geometry || typeof geometry !== 'object') return null;
  const g = geometry as { type?: unknown; coordinates?: unknown; geometries?: unknown };
  switch (g.type) {
    case 'Point':
    case 'MultiPoint':
    case 'LineString':
    case 'MultiLineString':
    case 'Polygon':
    case 'MultiPolygon': {
      const acc = new Accumulator();
      walkCoordinates(g.coordinates, acc);
      return acc.result();
    }
    case 'GeometryCollection': {
      if (!Array.isArray(g.geometries)) return null;
      let out: Envelope | null = null;
      for (const member of g.geometries) {
        out = unionEnvelopes(out, geometryEnvelope(member));
      }
      return out;
    }
    default:
      return null;
  }
}

/** Envelope over a batch of geometries; null entries and geometries
 *  without a usable position contribute nothing. */
export function envelopeOfGeometries(
  geometries: Iterable<unknown>,
): Envelope | null {
  let out: Envelope | null = null;
  for (const geometry of geometries) {
    out = unionEnvelopes(out, geometryEnvelope(geometry));
  }
  return out;
}

export function unionEnvelopes(
  a: Envelope | null,
  b: Envelope | null,
): Envelope | null {
  if (!a) return b ? [b[0], b[1], b[2], b[3]] : null;
  if (!b) return [a[0], a[1], a[2], a[3]];
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
}

export function envelopesEqual(
  a: Envelope | null,
  b: Envelope | null,
): boolean {
  if (!a || !b) return a === b;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/**
 * True when `inner` lies strictly inside `outer`, touching none of
 * its four edges. This is the condition under which removing (or
 * moving away from) `inner` cannot change `outer`'s extent: an
 * extent edge is always defined by some geometry reaching it, and a
 * geometry strictly inside reaches none. Touching an edge is enough
 * to need the full recompute, because that geometry might have been
 * the only thing holding the edge where it is.
 */
export function envelopeStrictlyInside(inner: Envelope, outer: Envelope): boolean {
  return (
    inner[0] > outer[0] &&
    inner[1] > outer[1] &&
    inner[2] < outer[2] &&
    inner[3] < outer[3]
  );
}

/** Read a stored `item.bbox` value back as an Envelope, or null when
 *  the column holds the "no extent" marker (`[]`, null) or garbage. */
export function readStoredEnvelope(raw: unknown): Envelope | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  if (!raw.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  return [raw[0] as number, raw[1] as number, raw[2] as number, raw[3] as number];
}

class Accumulator {
  private w = Infinity;
  private s = Infinity;
  private e = -Infinity;
  private n = -Infinity;
  private any = false;

  add(x: number, y: number): void {
    if (x < this.w) this.w = x;
    if (y < this.s) this.s = y;
    if (x > this.e) this.e = x;
    if (y > this.n) this.n = y;
    this.any = true;
  }

  result(): Envelope | null {
    return this.any ? [this.w, this.s, this.e, this.n] : null;
  }
}

/**
 * Recursive walk over a GeoJSON coordinates value of any nesting
 * depth. A position is an array whose first element is a number;
 * anything else that is an array is a ring, line or polygon list and
 * is descended into. Driving off the data rather than the declared
 * type means a Polygon whose coordinates are accidentally one level
 * too shallow still yields its positions instead of throwing, which
 * matters for a helper that runs on the write path and must never
 * break a save.
 */
function walkCoordinates(value: unknown, acc: Accumulator): void {
  if (!Array.isArray(value) || value.length === 0) return;
  if (typeof value[0] === 'number') {
    const x = value[0];
    const y = value[1];
    if (Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)) {
      acc.add(x, y);
    }
    return;
  }
  for (const child of value) walkCoordinates(child, acc);
}
