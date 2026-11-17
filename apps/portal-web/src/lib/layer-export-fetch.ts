// SPDX-License-Identifier: AGPL-3.0-or-later
// Reads a whole data layer, geometry included, for the client-side
// exports (CSV, Excel, GeoJSON) in the Attributes tab.
//
// Those exports used to be built from the table's loaded rows. The
// table reads `features-page`, which has no geometry and stops at
// 5,000 rows, so GeoJSON came out with null shapes, the Excel WKT
// column was empty, and every format was cut at 5,000 rows while the
// table said Export gives the complete table. This walks the paged
// GeoJSON read instead, pinned to one snapshot.

import type { ExportFeature } from './layer-export';

/** Rows per request. The server accepts up to 50,000. */
export const EXPORT_PAGE_SIZE = 5000;

/**
 * Upper bound on what a browser-built file holds. Past this the whole
 * layer sits in memory twice (rows plus the file), so the user is
 * pointed at GeoParquet, which the server writes in full.
 */
export const CLIENT_EXPORT_MAX_FEATURES = 200_000;

export class ExportTooLargeError extends Error {
  constructor() {
    super(
      `This layer has more than ${CLIENT_EXPORT_MAX_FEATURES.toLocaleString('en-US')} features, which is too many to build in the browser. Use the GeoParquet export for the full layer.`,
    );
    this.name = 'ExportTooLargeError';
  }
}

interface PageBody {
  features?: Array<{
    id?: unknown;
    geometry?: unknown;
    properties?: Record<string, unknown> | null;
  }>;
  nextCursor?: string | null;
  asOf?: string;
}

type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/**
 * Every feature of the layer with its geometry. `fetchImpl` is the
 * global fetch in the app and a fake in tests.
 */
export async function fetchLayerFeaturesForExport(
  itemId: string,
  layerId: string,
  fetchImpl: FetchLike = (url) => fetch(url),
): Promise<ExportFeature[]> {
  const base = `/api/portal/items/${encodeURIComponent(itemId)}/layers/${encodeURIComponent(layerId)}/geojson`;
  const out: ExportFeature[] = [];
  let cursor = '';
  let asOf: string | null = null;
  for (;;) {
    const params = new URLSearchParams({
      limit: String(EXPORT_PAGE_SIZE),
      cursor,
    });
    if (asOf) params.set('at', asOf);
    const res = await fetchImpl(`${base}?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`Could not read the layer for export (${res.status}).`);
    }
    const body = (await res.json()) as PageBody;
    for (const f of body.features ?? []) {
      out.push({
        ...(typeof f.id === 'string' ? { id: f.id } : {}),
        geometry: f.geometry ?? null,
        properties: f.properties ?? null,
      });
    }
    if (out.length > CLIENT_EXPORT_MAX_FEATURES) throw new ExportTooLargeError();
    // Every later page reads the same snapshot as the first.
    if (asOf === null && typeof body.asOf === 'string') asOf = body.asOf;
    if (!body.nextCursor) return out;
    cursor = body.nextCursor;
  }
}
