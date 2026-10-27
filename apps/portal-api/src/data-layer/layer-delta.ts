// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';
import type { SourceRef } from '@gratis-gis/engine';

/** Build the SourceRef that stamps a write batch's syncVersion onto
 *  every observation in that batch. Delta reads filter on this path. */
export function syncVersionSource(syncVersion: number): SourceRef {
  return {
    kind: 'data_layer:write',
    details: { syncVersion },
  };
}

/** `?since=` for /delta: non-negative integer, default 0. */
export function parseSinceParam(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0;
  if (!/^\d+$/.test(raw)) {
    throw new BadRequestException(
      'since must be a non-negative integer (layer syncVersion cursor).',
    );
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new BadRequestException(
      'since must be a non-negative integer (layer syncVersion cursor).',
    );
  }
  return n;
}

export const DELTA_DEFAULT_LIMIT = 1000;
export const DELTA_MAX_LIMIT = 10000;

/** `?limit=` for /delta. */
export function parseDeltaLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DELTA_DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) {
    throw new BadRequestException(
      `limit must be an integer between 1 and ${DELTA_MAX_LIMIT}.`,
    );
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > DELTA_MAX_LIMIT) {
    throw new BadRequestException(
      `limit must be an integer between 1 and ${DELTA_MAX_LIMIT}.`,
    );
  }
  return n;
}
