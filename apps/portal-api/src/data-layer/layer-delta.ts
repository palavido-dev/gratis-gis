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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `?after=` for /delta: the `nextAfter` observation id from the
 * previous truncated page. Absent or empty means start of `since`.
 */
export function parseDeltaAfterParam(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!UUID_RE.test(raw)) {
    throw new BadRequestException(
      'after must be the nextAfter observation id from a truncated delta page.',
    );
  }
  return raw.toLowerCase();
}

/**
 * `?bbox=west,south,east,north` for /delta: the area the client's cache
 * covers, in WGS84. Absent or empty means the whole layer. A device that
 * downloaded one town of a statewide layer otherwise pulled every change
 * in the state.
 */
export function parseDeltaBboxParam(
  raw: string | undefined,
): [number, number, number, number] | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parts = raw.split(',');
  const nums = parts.map((p) => (p.trim() === '' ? Number.NaN : Number(p)));
  if (
    nums.length !== 4 ||
    !nums.every((n) => Number.isFinite(n)) ||
    nums[0]! > nums[2]! ||
    nums[1]! > nums[3]!
  ) {
    throw new BadRequestException(
      'bbox must be west,south,east,north in degrees, with west <= east and south <= north.',
    );
  }
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
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
