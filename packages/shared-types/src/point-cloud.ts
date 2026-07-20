// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Canonical shape stored in an Item's data_json when
 * `type = 'point_cloud'` (#179, 3D-as-layers phase A).
 *
 * A point_cloud item wraps a single COPC file (Cloud Optimized
 * Point Cloud: LAZ 1.4 with a spec-defined octree, https://copc.io).
 * The bytes live in MinIO; viewers stream them with HTTP range
 * requests through the API's proxy endpoint, loading only the
 * octree nodes the current viewport needs. That is the same
 * serving model the tile_layer item uses for PMTiles, and it is
 * why COPC is the only accepted v1 format: plain LAS/LAZ has no
 * octree, so the whole file would have to download before the
 * first point renders. Non-COPC uploads are rejected at finalize
 * with a pointer to `pdal translate` (server-side conversion is
 * follow-up scope, capability-tiered per the workbench plan).
 *
 * Header metadata is lifted once at upload time so consumers
 * (detail page, map legend, search cards) never re-parse the
 * binary header.
 */
import type { ISODateString } from './ids';

export type PointCloudDataVersion = 1;

export interface PointCloudData {
  version: PointCloudDataVersion;
  /** Only COPC in v1. Kept as a field so a future EPT or 3D-Tiles
   *  flavor can join without a data migration. */
  format: 'copc';
  /** MinIO object key of the uploaded file. Used for serving and
   *  delete cleanup. */
  storageKey: string;
  /** API-mediated URL for the file (private storage kind; the
   *  bucket denies anonymous GET on the prefix). */
  storageUrl: string;
  /** Original upload filename for display + download naming. */
  fileName: string;
  /** Uploaded size in bytes. */
  sizeBytes: number;
  /** When the upload completed. */
  uploadedAt: ISODateString;

  // ---------------- metadata lifted from the LAS header ----------------

  /** Total number of point records. */
  pointCount?: number;
  /** Native-CRS bounds [minX, minY, minZ, maxX, maxY, maxZ]. */
  bounds?: [number, number, number, number, number, number];
  /** LAS version, e.g. '1.4' (COPC requires 1.4). */
  lasVersion?: string;
  /** Point data record format (COPC requires 6, 7, or 8; 7 and 8
   *  carry RGB). */
  pointFormat?: number;
  /** WKT CRS from the LASF_Projection VLR, when present. Raw WKT
   *  on purpose: parsing it to an EPSG code is lossy, and the
   *  browser reader (proj4) consumes WKT directly. */
  crsWkt?: string;
  /** Whether the point records carry RGB (derived from
   *  pointFormat 7/8). Drives the color-scheme picker default. */
  hasRgb?: boolean;

  /** Attribution surfaced wherever the layer renders. */
  attribution?: string;

  // ----------------------------- runtime URL -----------------------------

  /**
   * API path the viewer range-reads:
   * `/api/portal/point-cloud/<itemId>/file`. Stored so map layer
   * configs and copy-URL affordances don't have to compose it.
   */
  dataUrl?: string;
}

export const DEFAULT_POINT_CLOUD: PointCloudData = {
  version: 1,
  format: 'copc',
  storageKey: '',
  storageUrl: '',
  fileName: '',
  sizeBytes: 0,
  uploadedAt: new Date(0).toISOString() as ISODateString,
};

export function isPointCloudData(value: unknown): value is PointCloudData {
  if (!value || typeof value !== 'object') return false;
  const v = value as { version?: unknown; format?: unknown; storageKey?: unknown };
  if (v.version !== 1) return false;
  if (v.format !== 'copc') return false;
  if (typeof v.storageKey !== 'string') return false;
  return true;
}
