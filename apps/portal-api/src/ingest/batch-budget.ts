// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * When a streaming import flushes a batch.
 *
 * Batches used to flush on row count alone (5,000). That bounds memory
 * only when features are small. A batch of 5,000 detailed polygons can
 * be hundreds of MB of GeoJSON, and each batch is held about three
 * times over on its way to Postgres: the parsed objects, the
 * structured clone sent to the COPY encoder thread, and the encoded
 * COPY text. A 700 MB shapefile (#573) peaked at about 2.5 GB on its
 * second batch and killed a worker capped at 1.5 GB.
 *
 * So a batch also flushes once its estimated size reaches a byte
 * budget. Small features still go 5,000 at a time; big ones go in
 * smaller batches. A single feature larger than the budget still goes
 * through, alone.
 */

/** Rows per batch when features are small. */
export const DEFAULT_BATCH_ROWS = 5000;

/**
 * Estimated bytes per batch. 16 MiB of GeoJSON text keeps a batch's
 * working set well under 200 MB, and is still large enough that the
 * per-batch overhead (one encoder round trip, one progress update)
 * stays negligible.
 */
export const DEFAULT_BATCH_BYTES = 16 * 1024 * 1024;

/** Counts rows and estimated bytes, and says when to flush. */
export class BatchBudget {
  private rows = 0;
  private bytes = 0;

  constructor(
    readonly maxRows: number = DEFAULT_BATCH_ROWS,
    readonly maxBytes: number = DEFAULT_BATCH_BYTES,
  ) {
    if (!(maxRows >= 1)) throw new RangeError('maxRows must be at least 1');
    if (!(maxBytes >= 1)) throw new RangeError('maxBytes must be at least 1');
  }

  /** Record one row. Returns true when the batch should flush now. */
  add(bytes: number): boolean {
    this.rows += 1;
    if (Number.isFinite(bytes) && bytes > 0) this.bytes += bytes;
    return this.rows >= this.maxRows || this.bytes >= this.maxBytes;
  }

  /** Start counting a new batch. Call after each flush. */
  reset(): void {
    this.rows = 0;
    this.bytes = 0;
  }
}

/**
 * Rough size of an attribute record as JSON text. Strings count their
 * length, everything else a flat 8 bytes, plus the key. It only has to
 * be in the right range: geometry dominates for the files this guards
 * against.
 */
export function approxPropsBytes(props: Record<string, unknown>): number {
  let n = 2;
  for (const key of Object.keys(props)) {
    const v = props[key];
    n += key.length + 4;
    n += typeof v === 'string' ? v.length + 2 : 8;
  }
  return n;
}
