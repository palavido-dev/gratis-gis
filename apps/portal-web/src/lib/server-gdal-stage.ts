// SPDX-License-Identifier: AGPL-3.0-or-later
import { detectFormat } from '@/lib/spatial-import';

/**
 * Formats that have no honest in-browser parser and must go through
 * portal-api GDAL staging (`POST /api/portal/ingest/stage`) before a
 * per-layer import. File Geodatabase is the headline case; the create
 * wizard already stages these, and the v3 detail Import button must
 * too so multi-layer archives can ask for `sourceLayer`.
 */
export function needsServerGdalStage(filename: string): boolean {
  return detectFormat(filename) === 'fgdb';
}
