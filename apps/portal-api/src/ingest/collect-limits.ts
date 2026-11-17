// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Limits for the ingest routes that read a whole file into one
 * in-memory FeatureCollection (`/ingest/to-geojson`, the legacy
 * `/items/:id/ingest`, the per-layer collect).
 *
 * Those routes are open to every signed-in user and answer with the
 * whole collection as JSON. With only the 50 GiB import ceiling, one
 * zipped shapefile of a few million points blocked the event loop for
 * the whole read and then took the API past its memory limit. Large
 * files belong in the streaming import, which writes in batches.
 */
import { PayloadTooLargeException } from '@nestjs/common';

/** Upload ceiling for the collect routes. */
export const COLLECT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Features one collect may return. */
export const COLLECT_MAX_FEATURES = 250_000;

/** How often a collect loop yields to the event loop. */
const YIELD_EVERY = 2_000;

export function collectTooLarge(): PayloadTooLargeException {
  return new PayloadTooLargeException(
    `This file has more than ${COLLECT_MAX_FEATURES.toLocaleString('en-US')} features, too many to open in the browser. Create a data layer from it instead; the import handles files of any size.`,
  );
}

/**
 * Count features as they are collected: throws past the cap, and every
 * YIELD_EVERY features lets other requests run.
 */
export class CollectBudget {
  private n = 0;

  async take(): Promise<void> {
    this.n += 1;
    if (this.n > COLLECT_MAX_FEATURES) throw collectTooLarge();
    if (this.n % YIELD_EVERY === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}
