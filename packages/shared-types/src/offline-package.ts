// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Offline areas and the basemap packages built from them.
 *
 * Background: the field runtime used to take an area offline by
 * enumerating every raster tile in it and fetching them one at a
 * time. For the trails deployment that is 1,592,692 tiles and about
 * 40 GB, three quarters of it at zoom 19 alone, and it was aimed at
 * community tile servers whose usage policies prohibit exactly that.
 * The same area as a vector archive is 1,683 tiles and 8.6 MB,
 * because vector tiles overzoom: a client renders zoom 19 from zoom
 * 14 data. So the portal cuts one archive per area, once, and every
 * collector downloads that file instead of re-deriving it.
 *
 * An OfflineArea is the author's declaration ("this crew works
 * here"). An OfflinePackage is one build of it. They are separate
 * because a rebuild has to be able to fail, or to run for a while,
 * without disturbing the package collectors are currently using.
 */

/**
 * Author-defined area on a data_collection. Stored inline on the
 * item's data rather than in its own table: the shape is young, and
 * a JSON field can change without a migration. The builds it
 * produces are a real table, because they are a work queue.
 */
export interface OfflineArea {
  /** Stable within the item. Generated client-side at create. */
  id: string;
  /** Shown to collectors in the download list. */
  name: string;
  /** [west, south, east, north] in EPSG:4326. */
  bbox: [number, number, number, number];
  /**
   * Lowest zoom to include. Effectively always 0: the low zooms are
   * a handful of tiles and omitting them leaves a collector who
   * pinches out staring at nothing.
   */
  minZoom: number;
  /**
   * Highest zoom to include. Not the highest zoom a collector can
   * view, which is unbounded, because vector tiles overzoom. Past
   * about 14 the extra levels add size without adding anything a
   * person can see.
   */
  maxZoom: number;
  /**
   * Rebuild automatically once the current package is older than
   * this many days. Omitted means the author rebuilds by hand.
   * Basemap geometry moves slowly, so weekly or monthly is a
   * reasonable setting and anything faster is waste.
   */
  refreshDays?: number;
}

/**
 * Lifecycle of one build.
 *
 * `superseded` exists so that "which package should a collector
 * download?" has exactly one answer at every instant. A rebuild
 * inserts a fresh row and only demotes the incumbent once the new
 * one is on disk, so a failed rebuild leaves the working package
 * in place rather than a gap.
 */
export type OfflinePackageStatus =
  | 'queued'
  | 'building'
  | 'ready'
  | 'failed'
  | 'superseded';

/** One build, as the API reports it. */
export interface OfflinePackageSummary {
  id: string;
  areaId: string;
  status: OfflinePackageStatus;
  bbox: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
  /** Tiles the region needs. Known once the size check has run. */
  tileCount: number | null;
  /** Archive size on disk. Known once the build has finished. */
  sizeBytes: number | null;
  /** Populated only when status is 'failed'. */
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** An area plus its current build, which is what the UI renders. */
export interface OfflineAreaWithPackage {
  area: OfflineArea;
  /** Newest ready package, or null if none has ever succeeded. */
  current: OfflinePackageSummary | null;
  /** Queued or building package, if a rebuild is in flight. */
  pending: OfflinePackageSummary | null;
  /** Newest failed package, shown only when there is no pending one. */
  lastFailure: OfflinePackageSummary | null;
}

/**
 * Ceiling on a single package, in tiles.
 *
 * Measured rather than guessed: the 4,217 km2 trails area is 1,683
 * tiles and 8.6 MB, so tiles run about 5 KB each and this cap is
 * roughly 125 MB. That is already at the top of what a phone should
 * be asked to hold, and the limit is checked before any tile is
 * downloaded, so an author who draws half a continent finds out in
 * seconds instead of filling a disk.
 */
export const OFFLINE_PACKAGE_MAX_TILES = 25_000;

/**
 * Highest zoom an area may request. The upstream vector basemap is
 * built to zoom 15, so asking for more yields nothing.
 */
export const OFFLINE_PACKAGE_MAX_ZOOM = 15;

/** Default zoom ceiling for a new area. See OfflineArea.maxZoom. */
export const OFFLINE_PACKAGE_DEFAULT_MAX_ZOOM = 14;

/**
 * Validate an area definition. Returns a human-readable problem or
 * null. Shared so the wizard, the API and the worker all agree on
 * what is acceptable, rather than each holding its own opinion.
 */
export function validateOfflineArea(area: OfflineArea): string | null {
  if (!area.name.trim()) return 'Give the area a name.';
  const [w, s, e, n] = area.bbox;
  if (![w, s, e, n].every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return 'The area extent is not a valid set of coordinates.';
  }
  if (w < -180 || e > 180 || s < -90 || n > 90) {
    return 'The area extent falls outside the world.';
  }
  if (w >= e || s >= n) {
    return 'The area extent is empty.';
  }
  if (!Number.isInteger(area.minZoom) || area.minZoom < 0) {
    return 'The lowest detail level must be zero or more.';
  }
  if (
    !Number.isInteger(area.maxZoom) ||
    area.maxZoom > OFFLINE_PACKAGE_MAX_ZOOM
  ) {
    return `The highest detail level cannot be above ${OFFLINE_PACKAGE_MAX_ZOOM}.`;
  }
  if (area.maxZoom < area.minZoom) {
    return 'The highest detail level must be at least the lowest.';
  }
  if (
    area.refreshDays !== undefined &&
    (!Number.isInteger(area.refreshDays) || area.refreshDays < 1)
  ) {
    return 'Automatic rebuilds must be at least one day apart.';
  }
  return null;
}

/**
 * Tiles a bbox covers across a zoom range, using the standard Web
 * Mercator scheme.
 *
 * This is an upper bound, not the answer: the real extract only
 * keeps tiles the upstream archive actually holds, so ocean and
 * empty land cost nothing. The builder still runs the real count
 * before downloading. This exists so the authoring UI can warn
 * while the author is dragging the box, without a round trip.
 */
export function estimateTileCount(
  bbox: [number, number, number, number],
  minZoom: number,
  maxZoom: number,
): number {
  const [west, south, east, north] = bbox;
  // Clamp to the Web Mercator latitude limit. Beyond it the
  // projection runs to infinity and the tile maths stops meaning
  // anything.
  const latLimit = 85.0511287798066;
  const s = Math.max(south, -latLimit);
  const n = Math.min(north, latLimit);
  if (s >= n || west >= east) return 0;

  const lonToX = (lon: number, z: number) =>
    Math.floor(((lon + 180) / 360) * 2 ** z);
  const latToY = (lat: number, z: number) => {
    const rad = (lat * Math.PI) / 180;
    return Math.floor(
      ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z,
    );
  };

  let total = 0;
  for (let z = minZoom; z <= maxZoom; z += 1) {
    const span = 2 ** z;
    const x0 = Math.max(0, Math.min(span - 1, lonToX(west, z)));
    const x1 = Math.max(0, Math.min(span - 1, lonToX(east, z)));
    // y is inverted: north edge is the smaller row index.
    const y0 = Math.max(0, Math.min(span - 1, latToY(n, z)));
    const y1 = Math.max(0, Math.min(span - 1, latToY(s, z)));
    total += (x1 - x0 + 1) * (y1 - y0 + 1);
  }
  return total;
}
