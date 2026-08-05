// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

/**
 * Query-parameter handling for the keyset-paginated feature reads
 * (#220). Shared by the authenticated controller and its public
 * mirror: two copies of this validation would drift, and the pair that
 * drifted would be the security-relevant one.
 */

/** Largest page a caller may request. The engine clamps to 50 000
 *  internally; rejecting loudly above that is better than silently
 *  handing back fewer rows than were asked for, which a client would
 *  reasonably read as end-of-data. */
export const MAX_PAGE_SIZE = 50_000;
export const DEFAULT_PAGE_SIZE = 1000;

/** Shape of a stable feature / cursor id: a UUID. */
const CURSOR_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FeaturePaging {
  pageSize: number;
  after: string | null;
}

/**
 * Decide whether a request is a paged read, and validate it if so.
 * Returns null when the caller asked for neither `limit` nor `cursor`,
 * meaning "serve the historical whole-collection response".
 *
 * A malformed limit is refused rather than defaulted. `limit=abc`
 * quietly returning an entire 1.4M-feature layer is exactly the
 * behaviour that made the un-paged endpoint dangerous: the caller
 * believes it is holding a bounded read and finds out otherwise in
 * production.
 */
export function parsePagingParams(
  limit: string | undefined,
  cursor: string | undefined,
): FeaturePaging | null {
  if (limit === undefined && cursor === undefined) return null;

  let pageSize = DEFAULT_PAGE_SIZE;
  if (limit !== undefined) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_SIZE) {
      throw new BadRequestException(
        `Limit must be a whole number between 1 and ${MAX_PAGE_SIZE}.`,
      );
    }
    pageSize = n;
  }

  let after: string | null = null;
  if (cursor !== undefined && cursor !== '') {
    // The cursor is cast through ::uuid in the engine's SQL. Checking
    // the shape here turns a database error into a clear message.
    if (!CURSOR_SHAPE.test(cursor)) {
      throw new BadRequestException(
        'That page marker is not valid. Start the read again without a page marker.',
      );
    }
    after = cursor;
  }

  return { pageSize, after };
}
